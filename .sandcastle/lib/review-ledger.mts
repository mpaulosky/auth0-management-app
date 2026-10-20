// The local review's ledger and its stamp: what `/pre-push-review` found on a
// branch's diff, what became of each finding, and the check
// `.github/ci/gate-checks.sh` runs so nothing is pushed that the review didn't
// pass. Most of the threads GitHub's reviewers opened on this repo's PRs were
// about behaviour a review before the push could have caught, so the gate now
// asks for one.
//
// A ledger is keyed by the branch's own changes against its merge base with
// origin/main: their patch, with blob ids, line numbers and hunk headers left
// out (see diffKey). The key finds the ledger; the check then makes sure HEAD
// is the reviewed commit, or that commit with a clean merge of main and
// nothing else (see isReviewedCode). So a merge of main that leaves every hunk
// the branch changed as it was keeps the review, close to the rule PR
// Auto-Merge and Claude Review apply on GitHub, and a new commit, a conflict
// resolution or a main change inside one of the branch's hunks needs a new
// one.
//
// Ledgers live under the clone's .git (`review/<key>.json`, see ledgerDir), so
// every worktree of the clone sees them and nothing is committed. Sandcastle's
// sandboxes see an empty read-only folder there instead (protectedGitMounts in
// host-safety.mts): ledgers hold accepted security findings, which are never
// published. They are a process aid, not a security boundary against the
// person: anyone who can push can write one, as anyone can push with
// --no-verify.
//
// Run as a script: `scripts/review.sh <command>` (see USAGE below). Sandcastle
// doesn't use this module yet; it lives here for its type-check and tests.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { plainText } from "./plain-text.mts";

// The variable that skips the review check, for the gate runs that come
// before or during the review: the skill's own (each round's), and every gate
// in Sandcastle's sandbox until its reviewer runs the same review.
export const SKIP_REVIEW_ENV = "GATE_SKIP_REVIEW";

// The key of a branch with no changes against its base: nothing to review.
export const EMPTY_DIFF_KEY = "empty";

// The branch the Baseline's re-Apply pushes (repo-ci-baseline's reapply.sh).
export const REAPPLY_BRANCH = "chore/reapply-baseline";

// The Owned Baseline files, as `.claude/rules/baseline.md` lists them (a test
// keeps the two the same). A re-Apply changes only these, and they're
// reviewed in the Template's own PRs; this repository must never change them,
// so a review here could only raise findings nobody here may fix.
export const OWNED_PATHS = [
  ".github/workflows/*.yml",
  ".github/hooks/**",
  ".github/scripts/**",
  ".github/instructions/*.md",
  ".github/pull_request_template.md",
  "scripts/gate.sh",
  "scripts/check-branch-name.sh",
  "scripts/check-pr-title.sh",
  "scripts/tests/**",
  "docs/PROCESS.md",
  ".editorconfig",
  ".gitignore",
  ".markdownlint-cli2.jsonc",
  ".yamllint.yml",
  "codecov.yml",
  "GitVersion.yml",
  "global.json",
] as const;

// The files under an Owned pattern that the Template doesn't supply, which
// `.claude/rules/baseline.md` lists as this repository's own.
export const NOT_OWNED: ReadonlySet<string> = new Set([
  ".github/workflows/sandcastle.yml",
  ".github/workflows/copilot-review-sync.yml",
  "scripts/tests/check-git-hooks.test.sh",
]);

// A glob from OWNED_PATHS as a regular expression: `**` crosses folders, `*`
// doesn't.
const globPattern = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
const ownedPatterns = OWNED_PATHS.map(globPattern);

// Whether `path` falls under one of the Owned patterns, Owned or not.
export const underOwnedPattern = (path: string) => ownedPatterns.some((pattern) => pattern.test(path));

// Whether `path` is an Owned Baseline file.
export const isOwnedPath = (path: string) => !NOT_OWNED.has(path) && underOwnedPattern(path);

// One finding. `fixed` needs the regression test that pins it, or the reason
// it has none (a workflow or prose finding); `dismissed` needs the evidence
// that the reviewer was wrong, read from the code; `accepted` needs the reason
// a person accepted it; `open` waits for a person. `security` says whether
// it's a security weakness, whichever lens raised it: an accepted one is
// never published (renderReviewNotes).
const findingOf = <S extends z.ZodType<boolean | undefined>>(security: S) =>
  z
    .object({
      id: z.string().regex(/^R[1-9]\d{0,5}$/, "ids are R1, R2, ... up to R999999, with no leading zero"),
      lens: z.string().trim().min(1),
      // A repository path: no whitespace, markup or backtick, so it can't carry
      // anything into the PR description that plainText would have to undo.
      path: z.string().trim().min(1).regex(/^[^\s<>`]+$/, "a path has no whitespace, <, > or backtick"),
      line: z.number().int().nonnegative(),
      summary: z.string().trim().min(1),
      security,
      status: z.enum(["fixed", "dismissed", "accepted", "open"]),
      test: z.string().trim().min(1).nullable(),
      reason: z.string().trim().min(1).nullable(),
    })
    .strict()
    .superRefine((finding, context) => {
      if (finding.status === "fixed" && finding.test === null && finding.reason === null) {
        context.addIssue({ code: "custom", message: `${finding.id} is fixed but names neither its test nor why it has none` });
      }
      if ((finding.status === "accepted" || finding.status === "dismissed") && finding.reason === null) {
        context.addIssue({ code: "custom", message: `${finding.id} is ${finding.status} without a reason` });
      }
    });

// A finding a review records: triage must decide `security` for every one.
export const findingSchema = findingOf(z.boolean());

// A finding as stored. A ledger recorded before `security` existed has none
// and still parses, so check, accept, report and latest read it. The report
// and the notes treat a missing mark as a security finding, so it isn't
// published undecided.
export const storedFindingSchema = findingOf(z.boolean().optional());

export type Finding = z.infer<typeof storedFindingSchema>;

// What the skill hands to `record`: the key and the HEAD `scripts/review.sh
// prepare` printed when the last round started, from the patch its reviewers
// read; how many rounds ran; and every finding this run raised, with its
// outcome. Never `accepted`: only a person running `scripts/review.sh accept`
// accepts a finding, on the ledger it was raised in, so no acceptance carries
// from one ledger to another.
export const reviewInputSchema = z
  .object({
    reviewedKey: z.string().min(1),
    reviewedHead: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "reviewedHead is the commit id prepare printed"),
    rounds: z.number().int().min(1),
    findings: z.array(findingSchema),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.findings.map((finding) => finding.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
      context.addIssue({ code: "custom", message: `finding ids repeat: ${[...new Set(repeated)].join(", ")}` });
    }
    const accepted = input.findings.filter((finding) => finding.status === "accepted").map((finding) => finding.id);
    if (accepted.length > 0) {
      context.addIssue({
        code: "custom",
        message: `${accepted.join(", ")} can't be recorded as accepted: record it open, and the person accepts it with scripts/review.sh accept`,
      });
    }
  });

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const ledgerSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1),
    branch: z.string(),
    base: z.string().min(1),
    head: z.string().min(1),
    recordedAt: z.string().min(1),
    rounds: z.number().int().min(1),
    findings: z.array(storedFindingSchema),
    // The highest id any review of the branch had used when this one was
    // recorded, so a review that found nothing still holds the ids taken.
    lastId: z.number().int().min(0).optional(),
  })
  .strict();

export type Ledger = z.infer<typeof ledgerSchema>;

// The variables a hook sets, which would point a worktree's git at another
// checkout's, and the ones that change what `git diff` prints.
const hookGitVariables = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF"];

// Run git in `cwd` and return its stdout as bytes, with the hook variables
// dropped. Replace refs are off, so the review reads and keys commits as they
// are, not as a replace ref shows them.
function gitBytes(cwd: string, args: readonly string[]): Buffer {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const name of hookGitVariables) {
    delete env[name];
  }
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

const git = (cwd: string, ...args: string[]) => gitBytes(cwd, args).toString("utf8").trim();

// Whether `ancestor` is an ancestor of (or is) `commit`. A commit git doesn't
// have counts as not.
function isAncestor(cwd: string, ancestor: string, commit: string): boolean {
  try {
    gitBytes(cwd, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

// Where this branch left origin/main. Throws when there's no origin/main: the
// review can't say what the branch changed, so the check fails closed.
export function mergeBase(cwd: string): string {
  try {
    return git(cwd, "merge-base", "origin/main", "HEAD");
  } catch (error) {
    throw new Error("can't find where this branch left origin/main: run `git fetch origin main` first", { cause: error });
  }
}

// HEAD's commit id, resolved once so a key and the head a ledger records
// describe the same commit even if HEAD moves meanwhile.
export const headCommit = (cwd: string) => git(cwd, "rev-parse", "--verify", "HEAD^{commit}");

// The `git diff` settings the patch's text depends on, pinned, so a key
// depends on the two trees and not on whose config made it (the explicit
// prefixes also override diff.noprefix and diff.mnemonicPrefix). A binary file is
// keyed by its blob ids, not its compressed bytes, so zlib's settings don't
// matter either. Submodules are never ignored: a pointer bump is a change to
// review. A different git version could still print a patch differently;
// that fails closed, with a new review.
const pinnedDiff = [
  "-c", "core.quotePath=true",
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.relative=false",
  "-c", "diff.suppressBlankEmpty=false",
  "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--full-index",
  "--unified=3", "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-indent-heuristic",
  "--submodule=short", "--ignore-submodules=none", "-O/dev/null", "--src-prefix=a/", "--dst-prefix=b/",
];

// The pinned patch of `head` against `base`: what the reviewers read. Throws
// when it shows a text file only as "Binary files differ": a diff attribute
// (in .gitattributes or the clone's info/attributes) would otherwise hide that
// change from the reviewers. A real binary file has a NUL byte, as git's own
// test for one does.
export function reviewPatch(cwd: string, base: string, head: string = headCommit(cwd)): Buffer {
  const patch = gitBytes(cwd, [...pinnedDiff, base, head]);
  const text = patch.toString("latin1");
  for (const section of text.split(/^(?=diff --git )/m)) {
    if (!/^Binary files .* differ$/m.test(section)) continue;
    const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(section)?.slice(1) ?? [];
    const binary = blobs.some((blob) => !/^0+$/.test(blob) && gitBytes(cwd, ["cat-file", "blob", blob]).includes(0));
    if (!binary) {
      const file = /^diff --git (.*)$/m.exec(section)?.[1] ?? "a file";
      throw new Error(`${file}: a diff attribute marks this text file binary, so the reviewers couldn't read its change. Remove the attribute.`);
    }
  }
  return patch;
}

// The ledger key of a patch: a SHA-256 of each file's part of it. A text
// file's `index` line (blob ids, which change when main changes another part
// of the same file) is left out and its hunk headers (line numbers, and the
// function names .gitattributes can change) are reduced to `@@`, leaving each
// hunk's context and changed lines: the branch's own change. A binary file
// has only its header, so its `index` line, with full blob ids, is kept.
export function patchKey(patch: Buffer): string {
  if (patch.length === 0) return EMPTY_DIFF_KEY;
  const hash = createHash("sha256");
  let section: Buffer[] = [];
  const flush = () => {
    const binary = section.some((line) => line.subarray(0, 13).toString("latin1") === "Binary files ");
    for (const line of section) {
      const text = line.subarray(0, 6).toString("latin1");
      if (!binary && text === "index ") continue;
      hash.update(!binary && text.startsWith("@@ ") ? Buffer.from("@@\n") : line);
    }
    section = [];
  };
  let start = 0;
  while (start < patch.length) {
    const newline = patch.indexOf(10, start);
    const end = newline === -1 ? patch.length : newline + 1;
    const line = patch.subarray(start, end);
    if (line.subarray(0, 11).toString("latin1") === "diff --git ") flush();
    section.push(line);
    start = end;
  }
  flush();
  return hash.digest("hex");
}

// The ledger key for `head`'s diff against `base`.
export const diffKey = (cwd: string, base: string, head: string = headCommit(cwd)) => patchKey(reviewPatch(cwd, base, head));

// Whether `head` is the code reviewed at `reviewedHead`: that commit, or it
// with a clean merge of `base` and nothing else. The key alone can't tell: an
// edit moved to an identical block elsewhere in a file keeps it. Anything git
// can't answer (a commit it doesn't have, a conflict) counts as not.
export function isReviewedCode(cwd: string, reviewedHead: string, base: string, head: string): boolean {
  if (head === reviewedHead) return true;
  try {
    const merged = git(cwd, "merge-tree", "--write-tree", reviewedHead, base).split("\n")[0];
    return merged === git(cwd, "rev-parse", `${head}^{tree}`);
  } catch {
    return false;
  }
}

// Whether this git has `merge-tree --write-tree` (2.38 and later), which
// isReviewedCode needs to see a merge of main as the reviewed code.
function mergeTreeWorks(cwd: string): boolean {
  const head = headCommit(cwd);
  try {
    git(cwd, "merge-tree", "--write-tree", head, head);
    return true;
  } catch {
    return false;
  }
}

// The folder ledgers live in, shared by every worktree of the clone: the
// review folder in the common directory git names.
export function ledgerDir(cwd: string): string {
  const common = git(cwd, "rev-parse", "--git-common-dir");
  return join(isAbsolute(common) ? common : join(cwd, common), "review");
}

const ledgerPath = (cwd: string, key: string) => join(ledgerDir(cwd), `${key}.json`);

// The ledger recorded for `key`, or undefined when there's none. Throws on a
// ledger that doesn't parse, naming it: a damaged ledger isn't a passed
// review.
export function readLedger(cwd: string, key: string): Ledger | undefined {
  const path = ledgerPath(cwd, key);
  if (!existsSync(path)) return undefined;
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`the review recorded at ${path} is damaged, so it doesn't count: run /pre-push-review again to record a new one`, { cause: error });
  }
}

// Write a ledger whole: to a file of its own, then renamed over the old one,
// so a reader never sees half a ledger.
function writeLedger(cwd: string, ledger: Ledger): void {
  const path = ledgerPath(cwd, ledger.key);
  const temporary = `${path}.${process.pid}.tmp`;
  // Owner-only: a ledger can hold accepted security findings.
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// Run `change` holding the review folder's lock, so two writers (a `record`
// and an `accept`) can't interleave. One lock for every key, not one per key:
// a record reads every review of the branch for the ids taken (takenIds), so a
// record on another diff mustn't write between that read and its own write.
// Fails at once, naming the lock, when another holds it.
function withLock<T>(cwd: string, change: () => T): T {
  mkdirSync(ledgerDir(cwd), { recursive: true, mode: 0o700 });
  chmodSync(ledgerDir(cwd), 0o700);
  const lock = join(ledgerDir(cwd), ".lock");
  let handle: number;
  try {
    handle = openSync(lock, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`another review command is writing a review; try again, or delete ${lock} if none is running`, { cause: error });
    }
    throw error;
  }
  try {
    return change();
  } finally {
    closeSync(handle);
    rmSync(lock, { force: true });
  }
}

// The nearest earlier review of this branch's own work: the ledger recorded
// at the commit nearest HEAD among HEAD's ancestors that main doesn't have.
// Context for the next review: its reviewers don't raise again what was fixed
// or dismissed, and raise again what was accepted or left open, for the person
// to decide for the new code. Nothing is carried from it. A file that doesn't
// read or parse is skipped.
export function latestLedger(cwd: string, base: string, head: string = headCommit(cwd)): Ledger | undefined {
  let latest: { ledger: Ledger; distance: number } | undefined;
  for (const { ledger, distance } of branchLedgers(cwd, base, head)) {
    if (latest === undefined || distance < latest.distance || (distance === latest.distance && ledger.recordedAt > latest.ledger.recordedAt)) {
      latest = { ledger, distance };
    }
  }
  return latest?.ledger;
}

// Every review recorded at one of the branch's own commits (HEAD's ancestors
// that main doesn't have), with how many commits each is behind HEAD.
function branchLedgers(cwd: string, base: string, head: string): { ledger: Ledger; distance: number }[] {
  const dir = ledgerDir(cwd);
  if (!existsSync(dir)) return [];
  const found: { ledger: Ledger; distance: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let ledger: Ledger;
    try {
      const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      ledger = parsed.data;
    } catch {
      continue;
    }
    if (!isAncestor(cwd, ledger.head, head) || isAncestor(cwd, ledger.head, base)) continue;
    found.push({ ledger, distance: Number(git(cwd, "rev-list", "--count", `${ledger.head}..${head}`)) });
  }
  return found;
}

// The highest id a review had taken, its own or one it held from earlier
// reviews; 0 for none.
const highestId = (ledger: Ledger | undefined): number =>
  Math.max(ledger?.lastId ?? 0, ...(ledger?.findings ?? []).map((finding) => Number(finding.id.slice(1))));

// The highest id the ledger at `key` or any review of the branch's own
// commits took; 0 for none.
export function takenIds(cwd: string, base: string, head: string = headCommit(cwd), key: string = diffKey(cwd, base, head)): number {
  let replaced: Ledger | undefined;
  try {
    replaced = readLedger(cwd, key);
  } catch {
    // A damaged ledger can't be accepted against, so its ids name nothing.
  }
  return Math.max(highestId(replaced), ...branchLedgers(cwd, base, head).map(({ ledger }) => highestId(ledger)));
}

// Record a review of HEAD's diff, replacing any ledger at the same diff.
// Refuses a dirty worktree, and a HEAD that isn't the code the last round
// reviewed: the review would vouch for code it never read. Also refuses any id
// at or below the highest the ledger it replaces or any earlier review of the
// branch's own commits took, so an id names one finding along the branch: a
// person who read a report before a review was recorded again can't accept a
// different finding by its id. (A rebase or an amend leaves the branch's
// earlier commits behind, and their ids with them, unless the diff is the same.)
export function recordReview(
  cwd: string,
  base: string,
  input: ReviewInput,
  now: Date = new Date(),
  taken: typeof takenIds = takenIds,
): Ledger {
  const parsed = reviewInputSchema.parse(input);
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=all");
  if (dirty !== "") {
    throw new Error(`the worktree has uncommitted changes, so the review can't vouch for HEAD:\n${dirty}`);
  }
  const head = headCommit(cwd);
  const key = diffKey(cwd, base, head);
  if (key !== parsed.reviewedKey || !isReviewedCode(cwd, parsed.reviewedHead, base, head)) {
    throw new Error("HEAD isn't the code the last review round read: commits landed after it started. Review again before recording.");
  }
  let ledger: Ledger = {
    version: 1,
    key,
    branch: git(cwd, "branch", "--show-current"),
    base,
    head,
    recordedAt: now.toISOString(),
    rounds: parsed.rounds,
    findings: parsed.findings,
  };
  withLock(cwd, () => {
    const floor = taken(cwd, base, head, key);
    const reused = parsed.findings.filter((finding) => Number(finding.id.slice(1)) <= floor).map((finding) => finding.id);
    if (reused.length > 0) {
      throw new Error(`ids up to R${floor} are taken by earlier reviews of this branch, so ${reused.join(", ")} can't be used: number this run's findings after R${floor}`);
    }
    ledger = { ...ledger, lastId: Math.max(floor, highestId(ledger)) };
    writeLedger(cwd, ledger);
  });
  return ledger;
}

// Accept an open finding on the ledger for HEAD's diff, with the person's
// reason. A finding that isn't open stays as it is.
export function acceptFinding(cwd: string, base: string, id: string, reason: string): Ledger {
  if (reason.trim() === "") throw new Error("say why the finding is accepted");
  const key = diffKey(cwd, base);
  return withLock(cwd, () => {
    const ledger = readLedger(cwd, key);
    if (ledger === undefined) throw new Error("no review is recorded for this diff: run /pre-push-review first");
    const finding = ledger.findings.find((candidate) => candidate.id === id);
    if (finding === undefined) throw new Error(`the review has no finding ${id}`);
    if (finding.status !== "open") throw new Error(`${id} is already ${finding.status}`);
    finding.status = "accepted";
    finding.reason = reason.trim();
    writeLedger(cwd, ledgerSchema.parse(ledger));
    return ledger;
  });
}

export type ReviewCheck = { ok: boolean; message: string };

// The gate's review check: HEAD's diff has a recorded review with no open
// finding. Three things pass without one: `GATE_SKIP_REVIEW=1` (that value
// only), a branch with no changes against the base, and a Baseline re-Apply
// on REAPPLY_BRANCH that changes only Owned files.
export function checkReview(cwd: string, base: string, env: NodeJS.ProcessEnv = process.env): ReviewCheck {
  if (env[SKIP_REVIEW_ENV] === "1") {
    return { ok: true, message: `Review check skipped (${SKIP_REVIEW_ENV}=1).` };
  }
  const head = headCommit(cwd);
  const key = diffKey(cwd, base, head);
  if (key === EMPTY_DIFF_KEY) return { ok: true, message: "No changes against origin/main to review." };
  if (git(cwd, "branch", "--show-current") === REAPPLY_BRANCH) {
    // The key's own pins: no renames (a file moved into an Owned folder is
    // still a change elsewhere), no ignored submodules, no relative paths, and
    // no trimming, so a name starting with a space keeps it.
    const paths = gitBytes(cwd, ["-c", "diff.relative=false", "diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", base, head])
      .toString("utf8")
      .split("\0")
      .filter((path) => path !== "");
    if (paths.every(isOwnedPath)) {
      return { ok: true, message: "A Baseline re-Apply that changes only Owned files: the Template's own review covers them." };
    }
  }
  const ledger = readLedger(cwd, key);
  if (ledger !== undefined && ledger.head !== head && !mergeTreeWorks(cwd)) {
    return {
      ok: false,
      message: `${git(cwd, "version")} can't check the review across a merge of main: that needs git 2.38 or later (merge-tree --write-tree). Upgrade git.`,
    };
  }
  if (ledger === undefined || !isReviewedCode(cwd, ledger.head, base, head)) {
    return { ok: false, message: "No review is recorded for this diff. Run /pre-push-review, which reviews, fixes and records it." };
  }
  const open = ledger.findings.filter((finding) => finding.status === "open");
  if (open.length > 0) {
    const lines = open.map((finding) => `  ${finding.id} ${finding.path}:${finding.line} (${finding.lens}): ${finding.summary}`);
    return {
      ok: false,
      message: [
        `${open.length} review finding(s) wait for a person. Fix them and run /pre-push-review again, or the person you work for accepts each one (never an agent on their behalf):`,
        ...lines,
        '  scripts/review.sh accept <id> "<reason>"',
      ].join("\n"),
    };
  }
  return { ok: true, message: `Reviewed clean: ${ledger.findings.length} finding(s), all fixed, dismissed or accepted.` };
}

// Reviewer and person text as one line of plain Markdown (plainText, in
// lib/plain-text.mts: no mention, reference, closing keyword, tag or code span gets
// through), with pipes escaped for a table cell.
const cell = (text: string) => plainText(text).replace(/\|/g, "\\|");

const where = (finding: Finding) => cell(`${finding.path}:${finding.line}`);

// The review report: every finding, where it is, what happened to it, and the
// test or reason behind that.
export function renderReport(ledger: Ledger): string {
  const header = `Review of ${ledger.branch === "" ? "HEAD" : cell(ledger.branch)} at ${ledger.head.slice(0, 12)}: ${ledger.rounds} round(s), ${ledger.findings.length} finding(s).`;
  if (ledger.findings.length === 0) return `${header}\n\nNo findings.\n`;
  const rows = ledger.findings.map(
    (finding) =>
      `| ${finding.id} | ${cell(finding.lens)}${finding.security === false ? "" : " (security)"} | ${where(finding)} | ${cell(finding.summary)} | ${finding.status} | ${cell(finding.test ?? finding.reason ?? "")} |`,
  );
  return [header, "", "| Id | Lens | Where | Finding | Status | Test or reason |", "| --- | --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

// The PR description's `## Review notes`: the findings a person accepted, for
// people reading the PR, except security findings, which are only counted.
// GitHub's reviewers aren't known to read the description, so a thread one
// opens on an accepted finding gets the same "Left for the owner." reply as
// every thread left for the owner (CLAUDE.md); the reason stays in the ledger
// and, for a finding that isn't a security one, in these notes. Empty when
// none was accepted.
export function renderReviewNotes(ledger: Ledger): string {
  const accepted = ledger.findings.filter((finding) => finding.status === "accepted");
  // An accepted security finding is a known weakness left as it is, and the
  // description becomes public release notes: it's tracked privately instead
  // (docs/SECURITY.md), and only counted here.
  const security = accepted.filter((finding) => finding.security !== false || /security/i.test(finding.lens));
  const listed = accepted.filter((finding) => !security.includes(finding));
  if (accepted.length === 0) return "";
  const privately =
    security.length === 0
      ? []
      : ["", `${security.length} accepted security finding(s) are left out here and reported privately, as docs/SECURITY.md describes.`];
  if (listed.length === 0) return ["## Review notes", ...privately, ""].join("\n");
  const lines = listed.map(
    (finding) => `- ${plainText(`${finding.path}:${finding.line}`)}: ${plainText(finding.summary)} Accepted: ${plainText(finding.reason ?? "")}`,
  );
  return ["## Review notes", "", "The local review raised these and they were accepted, not changed:", "", ...lines, ...privately, ""].join("\n");
}

const USAGE = `Usage: scripts/review.sh <command>
  prepare <absolute dir> write HEAD's diff to <dir>/diff.patch for the reviewers; print its key, then HEAD
  key                    print the ledger key of HEAD's diff against origin/main
  check [<base>]         the gate's check: exit 1 unless HEAD's diff was reviewed clean
  record <file>          record a review from JSON ({ reviewedKey, reviewedHead, rounds, findings }); - reads stdin
  accept <id> <reason>   accept an open finding on HEAD's review
  report                 print HEAD's review report
  notes                  print the "## Review notes" section for the PR description
  latest                 print the nearest earlier review of this branch's work as JSON ({} when none)
  next                   print the first finding id this run may use`;

// The command line. Returns the exit code: 0 only for a command that did
// what it was asked, so the gate can't pass on a failure.
export function main(args: readonly string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): number {
  const [command, ...rest] = args;
  const out = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  const fail = (text: string) => {
    process.stderr.write(`${text}\n`);
    return 1;
  };
  try {
    switch (command) {
      case "key":
        out(diffKey(cwd, mergeBase(cwd)));
        return 0;
      case "prepare": {
        // An absolute folder only: an empty shell variable would otherwise
        // write the diff somewhere no reviewer is told to look.
        if (rest[0] === undefined || !isAbsolute(rest[0])) return fail(USAGE);
        // One read of the patch gives both, so the key names exactly the text
        // the reviewers get.
        const head = headCommit(cwd);
        const patch = reviewPatch(cwd, mergeBase(cwd), head);
        mkdirSync(rest[0], { recursive: true });
        writeFileSync(join(rest[0], "diff.patch"), patch);
        out(`${patchKey(patch)}\n${head}`);
        return 0;
      }
      case "check": {
        const result = checkReview(cwd, rest[0] || mergeBase(cwd), env);
        if (!result.ok) return fail(result.message);
        out(result.message);
        return 0;
      }
      case "record": {
        if (rest[0] === undefined) return fail(USAGE);
        const text = readFileSync(rest[0] === "-" ? 0 : rest[0], "utf8");
        out(renderReport(recordReview(cwd, mergeBase(cwd), JSON.parse(text) as ReviewInput)));
        return 0;
      }
      case "accept": {
        const [id, ...reason] = rest;
        if (id === undefined || reason.length === 0) return fail(USAGE);
        out(renderReport(acceptFinding(cwd, mergeBase(cwd), id, reason.join(" "))));
        return 0;
      }
      case "report":
      case "notes": {
        const ledger = readLedger(cwd, diffKey(cwd, mergeBase(cwd)));
        if (ledger === undefined) return fail("No review is recorded for this diff.");
        out(command === "report" ? renderReport(ledger) : renderReviewNotes(ledger) || "No accepted findings.");
        return 0;
      }
      case "latest": {
        const ledger = latestLedger(cwd, mergeBase(cwd));
        out(ledger === undefined ? "{}" : JSON.stringify(ledger, null, 2));
        return 0;
      }
      case "next":
        out(`R${takenIds(cwd, mergeBase(cwd)) + 1}`);
        return 0;
      default:
        return fail(USAGE);
    }
  } catch (error) {
    return fail(error instanceof z.ZodError ? `The review doesn't parse:\n${z.prettifyError(error)}` : String((error as Error).message ?? error));
  }
}

// Whether this module is the script being run. Real paths are compared, so a
// symlinked checkout still runs the command: a guard that silently didn't
// match would exit 0 and let the gate pass.
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}

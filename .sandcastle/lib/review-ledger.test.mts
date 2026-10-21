import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptFinding,
  checkReview,
  diffKey,
  EMPTY_DIFF_KEY,
  isOwnedPath,
  underOwnedPattern,
  ledgerDir,
  main,
  mergeBase,
  NOT_OWNED,
  OWNED_PATHS,
  latestLedger,
  readLedger,
  recordReview,
  takenIds,
  renderReport,
  renderReviewNotes,
  REVIEW_NOTES_END,
  REVIEW_NOTES_START,
  reviewPatch,
  spliceReviewNotes,
  type Ledger,
  type ReviewInput,
} from "./review-ledger.mts";

// Only the config each test sets: a machine's global or system git config
// (commit signing, a hooks path, merge.ff=only, colour) mustn't decide these
// tests. Child processes inherit it too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// A finding as a review records it, with `security` decided.
type Finding = ReviewInput["findings"][number];

const moduleFile = fileURLToPath(new URL("./review-ledger.mts", import.meta.url));
const reviewScript = fileURLToPath(new URL("../../scripts/review.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// A clone with an origin whose main has two files, checked out on a feature
// branch that changed line 3 of the 50-line `app.cs`.
let root: string;
let repo: string;
let upstream: string;

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  run(cwd, "add", file);
  run(cwd, "commit", "--quiet", "-m", message);
}

const lines = (count: number, change: (index: number) => string | undefined = () => undefined) =>
  `${Array.from({ length: count }, (_, index) => change(index) ?? `line ${index}`).join("\n")}\n`;

// Bring main's latest commits into the branch with a merge commit.
function mergeMain(): void {
  run(repo, "fetch", "--quiet", "origin");
  run(repo, "merge", "--quiet", "--no-edit", "origin/main");
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "R1",
  lens: "Edge cases",
  path: "app.cs",
  line: 3,
  summary: "An email of only spaces passes the guard.",
  security: false,
  status: "fixed",
  test: "tests/AppTests.cs::Guard_WhitespaceEmail_Fails",
  reason: null,
  ...overrides,
});

// Record a review of HEAD's diff, as the skill does once its last round read it.
const reviewed = () => ({ reviewedKey: diffKey(repo, mergeBase(repo)), reviewedHead: run(repo, "rev-parse", "HEAD") });
// A finding given as accepted (with its reason) is recorded open and then
// accepted, the only way a ledger gets an acceptance.
function record(findings: Finding[], rounds = 1, now?: Date): Ledger {
  const toAccept = findings.filter((found) => found.status === "accepted" && found.reason !== null);
  const input = findings.map((found) => (toAccept.includes(found) ? { ...found, status: "open" as const, reason: null } : found));
  const ledger = recordReview(repo, mergeBase(repo), { ...reviewed(), rounds, findings: input }, now);
  if (toAccept.length === 0) return ledger;
  let accepted = ledger;
  for (const found of toAccept) accepted = acceptFinding(repo, mergeBase(repo), found.id, found.reason ?? "");
  return accepted;
}

// The branch's nearest earlier review.
const nearest = () => latestLedger(repo, mergeBase(repo));

// Run main() with stdout and stderr captured.
function cli(args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: string) => (out.push(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as typeof process.stderr.write;
  try {
    const code = main(args, cwd, env);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "review-ledger-")));
  upstream = join(root, "upstream");
  repo = join(root, "repo");
  run(root, "init", "--quiet", "-b", "main", upstream);
  commit(upstream, "app.cs", lines(50), "start");
  commit(upstream, "other.cs", "x\n", "other");
  run(root, "clone", "--quiet", upstream, repo);
  run(repo, "switch", "--quiet", "-c", "feature/1-thing");
  commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed" : undefined)), "change app");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("diffKey", () => {
  it("keeps the key when main moves on in files the branch didn't change and is merged in cleanly", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when main changes a distant part of a file the branch changed and is merged in cleanly", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "app.cs", lines(50, (index) => (index === 44 ? "main's change" : undefined)), "main edits line 45");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("changes the key when main changes a line inside one of the branch's hunks", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(upstream, "app.cs", lines(50, (index) => (index === 4 ? "main's change" : undefined)), "main edits line 5");
    mergeMain();

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when a clean merge of main moves one of the branch's hunks down the file", () => {
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed" : index === 29 ? "deep change" : undefined)), "two hunks");
    const before = diffKey(repo, mergeBase(repo));
    const mainLines = lines(50).split("\n");
    mainLines.splice(15, 0, "main's new line");
    commit(upstream, "app.cs", mainLines.join("\n"), "main inserts a line between the hunks");
    mergeMain();

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("keeps the key when a clean merge of main adds a .gitattributes that changes hunk headers", () => {
    // Indented filler matches no function-name pattern; only csharp's matches
    // the method line, so the attribute really changes the hunk's header.
    const file = (change: string) =>
      `${Array.from({ length: 20 }, (_, index) => (index === 5 ? "public void M()" : index === 12 ? `  ${change}` : `  filler ${index}`)).join("\n")}\n`;
    commit(upstream, "app.cs", file("original"), "a method");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "app.cs", file("changed"), "change inside the method");
    const header = () => run(repo, "diff", mergeBase(repo), "HEAD").split("\n").find((line) => line.startsWith("@@")) ?? "";
    const before = diffKey(repo, mergeBase(repo));
    const headerBefore = header();
    commit(upstream, ".gitattributes", "*.cs diff=csharp\n", "attributes");
    mergeMain();

    assert.notEqual(header(), headerBefore);
    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  it("doesn't depend on the diff settings of whoever computes it", () => {
    const before = diffKey(repo, mergeBase(repo));
    for (const [name, value] of [
      ["core.abbrev", "12"],
      ["diff.context", "5"],
      ["diff.noprefix", "true"],
      ["diff.algorithm", "patience"],
      ["diff.interHunkContext", "10"],
      ["diff.suppressBlankEmpty", "true"],
      ["core.compression", "9"],
    ]) {
      run(repo, "config", name as string, value as string);
    }
    const saved = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = "-u1";
    try {
      assert.equal(diffKey(repo, mergeBase(repo)), before);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = saved;
    }
  });

  it("doesn't depend on config or attributes that change how a richer diff is printed", () => {
    // A blank line inside a hunk, two hunks 8 lines apart, a non-ASCII name,
    // a swap that myers and patience print differently, and a binary file:
    // each pinned setting has something to change.
    const two = (a: string, b: string) =>
      `${["x0", "x1", "", "x3", a, "x5", "", "x7", "x8", "x9", "x10", "x11", "x12", "x13", "x14", b, "x16", "", "x18"].join("\n")}\n`;
    commit(upstream, "two.cs", two("a", "b"), "two");
    commit(upstream, "café.cs", "one\n", "accent");
    commit(upstream, "swap.txt", "}\n}\nA\n}\n}\nB\n}\n}\nC\n", "swap");
    commit(upstream, "slide.txt", "1\n2\na\n\nb\n3\n4\n", "slide");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "two.cs", two("A", "B"), "two hunks");
    commit(repo, "café.cs", "two\n", "accent change");
    commit(repo, "swap.txt", "}\n}\nB\n}\n}\nA\n}\n}\nC\n}\n", "swap A and B");
    // A block the indent heuristic slides, and a rename.
    commit(repo, "slide.txt", "1\n2\na\n\nb\na\n\nb\n3\n4\n", "slide");
    run(repo, "mv", "other.cs", "renamed.cs");
    run(repo, "commit", "--quiet", "-m", "rename");
    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(repo, "add", "logo.png");
    run(repo, "commit", "--quiet", "-m", "image");
    const before = diffKey(repo, mergeBase(repo));
    const script = join(root, "script.sh");
    writeFileSync(script, "#!/bin/sh\necho external\n");
    execFileSync("chmod", ["+x", script]);
    writeFileSync(join(root, "attributes"), "*.cs diff=rev binary\n*.png diff\n");
    writeFileSync(join(root, "order"), "two.cs\n*\n");
    for (const [name, value] of [
      ["core.quotePath", "false"],
      ["core.abbrev", "12"],
      ["core.attributesFile", join(root, "attributes")],
      ["diff.mnemonicPrefix", "true"],
      ["diff.noprefix", "true"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.interHunkContext", "10"],
      ["diff.algorithm", "patience"],
      ["diff.indentHeuristic", "false"],
      ["diff.renames", "false"],
      ["color.diff", "always"],
      ["color.ui", "always"],
      ["diff.orderFile", join(root, "order")],
      ["diff.external", script],
      ["diff.rev.textconv", "rev"],
    ]) {
      run(repo, "config", name as string, value as string);
    }
    writeFileSync(join(repo, ".git", "info", "attributes"), "*.cs diff=rev\n");

    assert.equal(diffKey(repo, mergeBase(repo)), before);
    // From a folder with no changes of its own, diff.relative would key nothing.
    run(repo, "config", "diff.relative", "true");
    mkdirSync(join(repo, "empty-folder"));
    assert.equal(diffKey(join(repo, "empty-folder"), mergeBase(repo)), before);
  });

  it("keys a binary file by its content, whatever zlib or attributes do with it", () => {
    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(repo, "add", "logo.png");
    run(repo, "commit", "--quiet", "-m", "image");
    const before = diffKey(repo, mergeBase(repo));
    run(repo, "config", "core.compression", "1");
    assert.equal(diffKey(repo, mergeBase(repo)), before);

    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 254]));
    run(repo, "commit", "--quiet", "-am", "new image");

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  it("keys a text file as text whatever core.bigFileThreshold says, rather than refuse it as binary", () => {
    const before = diffKey(repo, mergeBase(repo));

    run(repo, "config", "core.bigFileThreshold", "1");

    assert.equal(diffKey(repo, mergeBase(repo)), before);
  });

  for (const [change, after] of [
    ["deletes", undefined],
    ["turns into text", "now text\n"],
  ] as const) {
    it(`${after === undefined ? "reviews" : "refuses"} a branch that ${change} a binary file`, () => {
      writeFileSync(join(upstream, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
      run(upstream, "add", "logo.png");
      run(upstream, "commit", "--quiet", "-m", "image");
      run(repo, "fetch", "--quiet", "origin");
      run(repo, "reset", "--quiet", "--hard", "origin/main");
      if (after === undefined) {
        run(repo, "rm", "--quiet", "logo.png");
        run(repo, "commit", "--quiet", "-m", "delete the image");
      } else {
        commit(repo, "logo.png", after, "replace the image with text");
      }

      if (after === undefined) {
        assert.notEqual(diffKey(repo, mergeBase(repo)), EMPTY_DIFF_KEY);
        assert.match(reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")).toString("latin1"), /^Binary files .*logo\.png.* differ$/m);
      } else {
        // git prints the whole change as "Binary files differ", so the
        // reviewers would never read the new text.
        assert.throws(() => diffKey(repo, mergeBase(repo)), /logo\.png.*into text/);
      }
    });
  }

  it("refuses a binary file turned into text with a NUL past git's first 8000 bytes, which git still prints as text", () => {
    writeFileSync(join(upstream, "logo.png"), Buffer.from([0, 1, 2, 3, 0, 255]));
    run(upstream, "add", "logo.png");
    run(upstream, "commit", "--quiet", "-m", "image");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    writeFileSync(join(repo, "logo.png"), Buffer.concat([Buffer.from("text\n".repeat(1800)), Buffer.from([0]), Buffer.from("\n")]));
    run(repo, "commit", "--quiet", "-am", "replace the image with text");

    assert.throws(() => diffKey(repo, mergeBase(repo)), /logo\.png.*into text/);
  });

  it("sees a submodule pointer bump even when git is told to ignore submodules", () => {
    const sub = join(root, "sub");
    run(root, "init", "--quiet", "-b", "main", sub);
    commit(sub, "s.txt", "1\n", "one");
    const first = run(sub, "rev-parse", "HEAD");
    commit(sub, "s.txt", "2\n", "two");
    const second = run(sub, "rev-parse", "HEAD");
    run(repo, "switch", "--quiet", "-C", "feature/1-thing", "origin/main");
    run(repo, "update-index", "--add", "--cacheinfo", `160000,${first},lib`);
    run(repo, "commit", "--quiet", "-m", "add submodule");
    run(repo, "config", "diff.ignoreSubmodules", "all");
    const before = diffKey(repo, mergeBase(repo));
    run(repo, "update-index", "--cacheinfo", `160000,${second},lib`);
    // The override lets git 2.39, the sandbox's, commit a bump it's told to ignore.
    run(repo, "-c", "diff.ignoreSubmodules=none", "commit", "--quiet", "-m", "bump submodule");

    assert.notEqual(before, EMPTY_DIFF_KEY);
    const after = diffKey(repo, mergeBase(repo));
    assert.notEqual(after, before);
    run(repo, "config", "diff.submodule", "log");
    assert.equal(diffKey(repo, mergeBase(repo)), after);
  });

  it("changes the key when the branch commits again", () => {
    const before = diffKey(repo, mergeBase(repo));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed again" : undefined)), "fix");

    assert.notEqual(diffKey(repo, mergeBase(repo)), before);
  });

  for (const where of ["the branch's .gitattributes", "the clone's info/attributes"]) {
    it(`refuses a text file ${where} marks binary, which would hide its change from the reviewers`, () => {
      if (where.startsWith("the branch")) {
        commit(repo, ".gitattributes", "*.cs -diff\n", "attributes");
      } else {
        mkdirSync(join(repo, ".git", "info"), { recursive: true });
        writeFileSync(join(repo, ".git", "info", "attributes"), "*.cs -diff\n");
      }

      assert.throws(() => reviewPatch(repo, mergeBase(repo), run(repo, "rev-parse", "HEAD")), /app\.cs .*binary/);
      assert.throws(() => diffKey(repo, mergeBase(repo)), /binary/);
    });
  }

  it("reads and keys commits as they are, not as a replace ref shows them", () => {
    const base = mergeBase(repo);
    const key = diffKey(repo, base);
    const patch = reviewPatch(repo, base, run(repo, "rev-parse", "HEAD"));
    const real = run(repo, "rev-parse", "HEAD:app.cs");
    const substitute = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: lines(50), encoding: "utf8" }).trim();
    run(repo, "replace", real, substitute);

    assert.equal(diffKey(repo, base), key);
    assert.equal(reviewPatch(repo, base, run(repo, "rev-parse", "HEAD")).toString(), patch.toString());
  });

  it("says there's nothing to review when the branch has no changes", () => {
    run(repo, "switch", "--quiet", "main");

    assert.equal(diffKey(repo, mergeBase(repo)), EMPTY_DIFF_KEY);
  });

  it("ignores the git variables a hook sets, which would point it at another repository", () => {
    const expected = diffKey(repo, mergeBase(repo));
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    process.env.GIT_DIR = join(upstream, ".git");
    process.env.GIT_COMMON_DIR = join(upstream, ".git");
    try {
      assert.equal(diffKey(repo, mergeBase(repo)), expected);
      assert.equal(ledgerDir(repo), join(repo, ".git", "review"));
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("checkReview", () => {
  it("fails when no review is recorded for the diff", () => {
    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /\/pre-push-review/);
  });

  it("passes when every finding is fixed, dismissed or accepted", () => {
    record([
      finding(),
      finding({ id: "R2", status: "accepted", test: null, reason: "Out of scope, #81." }),
      finding({ id: "R3", status: "dismissed", test: null, reason: "The guard trims first: app.cs:2." }),
    ]);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("fails and names each finding that waits for a person", () => {
    record([finding({ id: "R4", status: "open", test: null })], 3);

    const result = checkReview(repo, mergeBase(repo), {});

    assert.equal(result.ok, false);
    assert.match(result.message, /R4 app\.cs:3 \(Edge cases\)/);
    assert.match(result.message, /scripts\/review\.sh accept/);
    assert.match(result.message, /the person you work for accepts each one \(never an agent on their behalf\)/);
  });

  it("fails again once a new commit changes the diff the review vouched for", () => {
    record([]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "changed later" : undefined)), "unreviewed change");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("fails when an edit moves to an identical block, which keeps the key but isn't the reviewed code", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const reviewed = diffKey(repo, mergeBase(repo));
    record([]);
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit to the second block");

    assert.equal(diffKey(repo, mergeBase(repo)), reviewed);
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("isn't passed by a replace ref that shows the moved edit as the reviewed commit", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const reviewed = run(repo, "rev-parse", "HEAD");
    record([]);
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit to the second block");
    run(repo, "replace", run(repo, "rev-parse", "HEAD"), reviewed);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("fails when git can't tell whether HEAD is the reviewed code", () => {
    const ledger = record([]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(ledger.head, "1".repeat(40)));

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  // Run `check` with a git 2.34 on the PATH, which has no merge-tree --write-tree.
  function checkWithOldGit(): ReturnType<typeof checkReview> {
    const bin = mkdtempSync(join(tmpdir(), "old-git-"));
    const real = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = version ]; then echo "git version 2.34.1"; exit 0; fi\nfor a in "$@"; do [ "$a" = --write-tree ] && { echo "error: unknown option" >&2; exit 129; }; done\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      return checkReview(repo, mergeBase(repo), {});
    } finally {
      process.env.PATH = path;
      rmSync(bin, { recursive: true, force: true });
    }
  }

  it("names a git too old to check the review across a merge of main, and its version, rather than say there's none", () => {
    record([]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    const result = checkWithOldGit();

    assert.equal(result.ok, false);
    assert.match(result.message, /git 2\.38 or later/);
    assert.match(result.message, /^git version 2\.34\.1 can't check/);
  });

  it("passes the reviewed commit itself on a git too old to check across a merge, which it doesn't need", () => {
    record([]);

    const result = checkWithOldGit();

    assert.equal(result.ok, true, result.message);
  });

  it("passes the reviewed commit with a clean merge of main and nothing else", () => {
    record([]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    mergeMain();

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("throws, naming the file, on a ledger that doesn't match the schema, rather than pass it", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"open"', '"OPEN"'));

    assert.throws(() => checkReview(repo, mergeBase(repo), {}), (error: Error) => error.message.includes(path));
  });

  it("throws on a truncated ledger rather than pass it", () => {
    const ledger = record([]);
    writeFileSync(join(ledgerDir(repo), `${ledger.key}.json`), '{"version": 1, "key":');

    assert.throws(() => checkReview(repo, mergeBase(repo), {}), /damaged/);
  });

  it("passes a Baseline re-Apply that changes only Owned files", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "scripts"));
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "scripts/gate.sh", "#!/bin/sh\n", "re-Apply");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("reviews a re-Apply branch that changes anything not Owned", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "app.cs", "sneaked in\n", "not Owned");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply that moves a file that isn't Owned into an Owned folder", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "scripts/tests"), { recursive: true });
    run(repo, "mv", "app.cs", "scripts/tests/app.cs");
    run(repo, "commit", "--quiet", "-m", "move");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply with a submodule bump that git is told to ignore", () => {
    const sub = join(root, "sub");
    run(root, "init", "--quiet", "-b", "main", sub);
    commit(sub, "s.txt", "1\n", "one");
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    run(repo, "update-index", "--add", "--cacheinfo", `160000,${run(sub, "rev-parse", "HEAD")},vendor`);
    run(repo, "-c", "diff.ignoreSubmodules=none", "commit", "--quiet", "-m", "submodule");
    commit(repo, "global.json", "{}\n", "re-Apply");
    run(repo, "config", "diff.ignoreSubmodules", "all");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply checked from a folder, whatever diff.relative says", () => {
    // From sub/, a relative diff would list sub/global.json as global.json,
    // which is Owned.
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    mkdirSync(join(repo, "sub"));
    commit(repo, "sub/global.json", "not Owned\n", "not Owned");
    run(repo, "config", "diff.relative", "true");

    assert.equal(checkReview(join(repo, "sub"), mergeBase(repo), {}).ok, false);
  });

  it("reviews a re-Apply whose first path starts with whitespace", () => {
    run(repo, "switch", "--quiet", "-C", "chore/reapply-baseline", "origin/main");
    commit(repo, "global.json", "{}\n", "re-Apply");
    commit(repo, "\tglobal.json", "sneaked in\n", "not Owned");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("reviews Owned-only changes on any other branch", () => {
    run(repo, "switch", "--quiet", "-C", "chore/edit-global", "origin/main");
    commit(repo, "global.json", "{}\n", "edit");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("is skipped when GATE_SKIP_REVIEW is 1", () => {
    assert.equal(checkReview(repo, mergeBase(repo), { GATE_SKIP_REVIEW: "1" }).ok, true);
  });

  it("is not skipped by any other value of GATE_SKIP_REVIEW", () => {
    assert.equal(checkReview(repo, mergeBase(repo), { GATE_SKIP_REVIEW: "true" }).ok, false);
  });

  it("passes a branch with nothing to review", () => {
    run(repo, "switch", "--quiet", "main");

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });
});

describe("recordReview", () => {
  it("refuses a dirty worktree, since the review couldn't vouch for HEAD", () => {
    writeFileSync(join(repo, "new.cs"), "untracked\n");

    assert.throws(() => record([]), /uncommitted changes/);
  });

  it("refuses a HEAD whose diff isn't the one the last round reviewed", () => {
    const round = reviewed();
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fixed after the round" : undefined)), "late fix");

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 3, findings: [] }), /Review again/);
  });

  it("refuses a clean merge of main that changed a line inside one of the branch's hunks after the round", () => {
    const round = reviewed();
    commit(upstream, "app.cs", lines(50, (index) => (index === 4 ? "main's change" : undefined)), "main edits line 5");
    mergeMain();

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 1, findings: [] }), /Review again/);
  });

  it("refuses a commit that keeps the key but isn't the code the last round read", () => {
    const block = (button: string) => `<div>\n  <p>a</p>\n  <p>b</p>\n  ${button}\n  <p>c</p>\n  <p>d</p>\n</div>\n`;
    commit(upstream, "page.razor", `${block("<button/>")}${block("<button/>")}`, "two identical blocks");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "reset", "--quiet", "--hard", "origin/main");
    commit(repo, "page.razor", `${block("<button disabled/>")}${block("<button/>")}`, "edit the first block");
    const round = reviewed();
    commit(repo, "page.razor", `${block("<button/>")}${block("<button disabled/>")}`, "move the edit after the round");

    assert.throws(() => recordReview(repo, mergeBase(repo), { ...round, rounds: 1, findings: [] }), /Review again/);
  });

  it("replaces a damaged ledger, so the review the error asks for can be recorded", () => {
    const ledger = record([]);
    writeFileSync(join(ledgerDir(repo), `${ledger.key}.json`), '{"version": 2');

    record([]);

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("refuses a fixed finding that names neither a test nor why it has none", () => {
    assert.throws(() => record([finding({ test: null })]), /neither its test/);
  });

  it("refuses an accepted finding without a reason", () => {
    assert.throws(() => record([finding({ status: "accepted", test: null })]), /accepted without a reason/);
  });

  it("refuses a dismissed finding without the evidence", () => {
    assert.throws(() => record([finding({ status: "dismissed", test: null })]), /dismissed without a reason/);
  });

  for (const path of ["a b.cs", "a<b.cs", "a>b.cs", "a`b.cs"]) {
    it(`refuses a path that isn't a plain repository path: ${JSON.stringify(path)}`, () => {
      assert.throws(() => record([finding({ path })]), /a path has no whitespace/);
    });
  }

  it("refuses a finding given as accepted: only the person accepts, with scripts/review.sh accept", () => {
    assert.throws(
      () => recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, findings: [finding({ status: "accepted", test: null, reason: "Says the agent." })] }),
      /R1 can't be recorded as accepted/,
    );
  });

  it("carries no acceptance into a new review: the person accepts again", () => {
    record([finding({ status: "accepted", test: null, reason: "Accepted on the earlier code." })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    const ledger = record([finding({ id: "R2", status: "open", test: null })]);

    assert.equal(ledger.findings[0]?.status, "open");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("replaces the same diff's ledger and carries none of its acceptances", () => {
    record([finding({ status: "accepted", test: null, reason: "Accepted on the first review." })]);

    const ledger = record([finding({ id: "R2", status: "open", test: null })]);

    assert.deepEqual(readLedger(repo, ledger.key)?.findings.map((found) => [found.id, found.status]), [["R2", "open"]]);
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, false);
  });

  it("refuses an id a review of the same diff at the same commit used, so an accept read from it can't land on another finding", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", lens: "Security", security: true, status: "open", test: null })]);

    assert.throws(() => record([finding({ lens: "Security", security: true, status: "open", test: null })]), /after R2/);
  });

  it("refuses an id the branch's earlier review used, so the two are never confused", () => {
    record([finding({ id: "R3", status: "open", test: null })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.throws(() => record([finding({ id: "R2" })]), /after R3/);
    assert.doesNotThrow(() => record([finding({ id: "R4" })]));
  });

  it("compares ids by number, refuses the highest one itself, and leaves the ledger as it was when it refuses", () => {
    const first = record([finding({ id: "R10", status: "open", test: null }), finding({ id: "R9", status: "open", test: null })]);

    assert.throws(() => record([finding({ id: "R10" })]), /after R10/);
    assert.throws(() => record([finding({ id: "R9" })]), /after R10/);
    assert.deepEqual(readLedger(repo, first.key), first);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    assert.doesNotThrow(() => record([finding({ id: "R11" })]));
  });

  it("keeps the ids taken through a review that found nothing, on the same diff and after it", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    record([]);
    assert.throws(() => record([finding()]), /after R2/);

    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    record([]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.throws(() => record([finding()]), /after R2/);
  });

  it("refuses an id the same diff's review used after a rebase, though that review is no longer the branch's", () => {
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    commit(upstream, "other.cs", "y\n", "main moves on");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "rebase", "--quiet", "origin/main");

    assert.equal(nearest(), undefined);
    assert.equal(cli(["next"]).out, "R3\n");
    assert.throws(() => record([finding()]), /after R2/);
  });

  it("takes the ids from every earlier review of the branch, not only the nearest", () => {
    const first = run(repo, "rev-parse", "HEAD");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");
    const second = run(repo, "rev-parse", "HEAD");
    record([finding({ status: "open", test: null })]);
    run(repo, "reset", "--quiet", "--hard", first);
    record([finding({ id: "R5", status: "open", test: null })]);
    run(repo, "reset", "--quiet", "--hard", second);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.equal(nearest()?.findings[0]?.id, "R1");
    assert.throws(() => record([finding({ id: "R2" })]), /after R5/);
  });

  it("still takes the ids of a review recorded before ledgers held the highest id", () => {
    const ledger = record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/,\s*"lastId": \d+/, ""));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.equal(nearest()?.key, ledger.key);
    assert.throws(() => record([finding()]), /after R2/);
  });

  for (const id of ["R100", "R999999"]) {
    it(`records an id as high as ${id}`, () => {
      assert.doesNotThrow(() => record([finding({ id })]));
    });
  }

  for (const id of ["R0", "R007", "R1234567", "XR1", " R1", "R1 "]) {
    it(`refuses an id that isn't R1 to R999999 written plainly: ${id}`, () => {
      assert.throws(() => record([finding({ id })]), /ids are R1, R2/);
    });
  }

  it("still reads and checks a ledger recorded before findings had a security mark", () => {
    const ledger = record([finding({ status: "accepted", test: null, reason: "Old acceptance." })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\s*"security": false,/g, ""));

    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
    assert.equal(latestLedger(repo, mergeBase(repo))?.findings[0]?.security, undefined);
  });

  it("refuses a finding whose security weakness wasn't decided", () => {
    const { security: _, ...undecided } = finding();

    assert.throws(() => record([undecided as Finding]), /security/);
  });

  it("refuses findings that share an id", () => {
    assert.throws(() => record([finding(), finding()]), /repeat: R1/);
  });

  it("refuses while another review command holds the ledger's lock", () => {
    const key = diffKey(repo, mergeBase(repo));
    mkdirSync(ledgerDir(repo), { recursive: true });
    writeFileSync(join(ledgerDir(repo), ".lock"), "held");

    assert.throws(() => record([]), /another review command/);
    assert.equal(readFileSync(join(ledgerDir(repo), ".lock"), "utf8"), "held");
  });

  it("reads the ids taken while it holds the lock, so no other record writes in between", () => {
    let locked: boolean | undefined;
    const taken = (...args: Parameters<typeof takenIds>) => {
      locked = existsSync(join(ledgerDir(repo), ".lock"));
      return takenIds(...args);
    };

    recordReview(repo, mergeBase(repo), { ...reviewed(), rounds: 1, findings: [] }, undefined, taken);

    assert.equal(locked, true);
  });

  it("refuses while another review command holds the lock, though it records another diff, since both read every review's ids", () => {
    record([]);
    writeFileSync(join(ledgerDir(repo), ".lock"), "");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.throws(() => record([]), /another review command/);
  });

  it("keeps ledgers readable only by their owner, in a folder only they can open", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(ledgerDir(repo)).mode & 0o777, 0o700);

    chmodSync(ledgerDir(repo), 0o755);
    acceptFinding(repo, mergeBase(repo), "R1", "Fine.");

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(ledgerDir(repo)).mode & 0o777, 0o700);
  });

  it("leaves no lock or temporary file behind", () => {
    const ledger = record([]);

    assert.deepEqual(readdirSync(ledgerDir(repo)), [`${ledger.key}.json`]);
  });

  it("replaces a ledger with a new file rather than rewriting it in place, so a reader never sees half of one", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    const path = join(ledgerDir(repo), `${ledger.key}.json`);
    const before = statSync(path).ino;
    const copy = join(root, "hard-link.json");
    linkSync(path, copy);

    acceptFinding(repo, mergeBase(repo), "R1", "Fine.");

    assert.notEqual(statSync(path).ino, before);
    assert.match(readFileSync(copy, "utf8"), /"open"/);
  });

  it("is shared by every worktree of the clone", () => {
    record([]);
    const other = join(root, "other");
    run(repo, "worktree", "add", "--quiet", "--detach", other, "HEAD");

    assert.equal(checkReview(other, mergeBase(other), {}).ok, true);
  });
});

describe("ledgerDir", () => {
  it("finds the clone's .git from a worktree, whose .git file names its folder by an absolute or a relative path", () => {
    const other = join(root, "other");
    run(repo, "worktree", "add", "--quiet", "--detach", other, "HEAD");
    assert.equal(realpathSync(ledgerDir(other).replace(/\/review$/, "")), join(repo, ".git"));

    writeFileSync(join(other, ".git"), "gitdir: ../repo/.git/worktrees/other\n");

    assert.equal(realpathSync(ledgerDir(other).replace(/\/review$/, "")), join(repo, ".git"));
  });
});

describe("acceptFinding", () => {
  it("accepts an open finding with the person's reason, so the check passes", () => {
    record([finding({ status: "open", test: null })], 3);

    acceptFinding(repo, mergeBase(repo), "R1", "The spec asks for it; tracked in #81.");

    const ledger = readLedger(repo, diffKey(repo, mergeBase(repo)));
    assert.equal(ledger?.findings[0]?.status, "accepted");
    assert.equal(ledger?.findings[0]?.reason, "The spec asks for it; tracked in #81.");
    assert.equal(checkReview(repo, mergeBase(repo), {}).ok, true);
  });

  it("refuses a finding that is already fixed", () => {
    record([finding()]);

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /already fixed/);
  });

  it("refuses an empty reason", () => {
    record([finding({ status: "open", test: null })]);

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "  "), /say why/);
  });

  it("refuses when no review is recorded for the diff", () => {
    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /no review is recorded/);
  });

  it("refuses while another review command holds the ledger's lock", () => {
    const ledger = record([finding({ status: "open", test: null })]);
    writeFileSync(join(ledgerDir(repo), ".lock"), "");

    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /another review command/);
  });

  it("releases the lock when it refuses, so the next command can run", () => {
    record([finding(), finding({ id: "R2", status: "open", test: null })]);
    assert.throws(() => acceptFinding(repo, mergeBase(repo), "R1", "why"), /already fixed/);

    assert.equal(readdirSync(ledgerDir(repo)).filter((name) => name.endsWith(".lock")).length, 0);
    assert.doesNotThrow(() => acceptFinding(repo, mergeBase(repo), "R2", "why"));
  });
});

describe("latestLedger", () => {
  it("returns the review nearest HEAD after fix commits changed the key", () => {
    record([finding({ status: "accepted", test: null, reason: "First." })], 1, new Date("2026-10-20T10:00:00Z"));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 1" : undefined)), "fix 1");
    record([finding({ id: "R2", status: "accepted", test: null, reason: "Second." })], 1, new Date("2026-10-20T09:00:00Z"));
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix 2" : undefined)), "fix 2");

    assert.equal(nearest()?.findings[0]?.reason, "Second.");
  });

  it("finds it after a rename, since the commits are the same work", () => {
    record([finding({ status: "accepted", test: null, reason: "Before the rename." })]);
    run(repo, "branch", "-m", "chore/renamed-branch");
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.equal(nearest()?.findings[0]?.reason, "Before the rename.");
  });

  it("ignores a review from an earlier branch of the same name that HEAD doesn't contain", () => {
    record([finding({ status: "accepted", test: null, reason: "Old branch." })]);
    run(repo, "switch", "--quiet", "-C", "feature/1-thing", "origin/main");
    commit(repo, "other.cs", "new work\n", "new branch, same name");

    assert.equal(nearest(), undefined);
  });

  it("ignores a review at a commit main already has", () => {
    record([finding({ status: "accepted", test: null, reason: "Merged long ago." })]);
    run(upstream, "fetch", "--quiet", repo, "feature/1-thing:merged");
    run(upstream, "merge", "--quiet", "--ff-only", "merged");
    run(repo, "fetch", "--quiet", "origin");
    run(repo, "switch", "--quiet", "-c", "feature/2-next", "origin/main");
    commit(repo, "other.cs", "next\n", "next work");

    assert.equal(nearest(), undefined);
  });

  it("returns nothing when no review was ever recorded", () => {
    assert.equal(nearest(), undefined);
  });

  it("skips a file in the review folder that doesn't parse", () => {
    record([finding({ status: "accepted", test: null, reason: "Kept." })]);
    writeFileSync(join(ledgerDir(repo), "broken.json"), '{"version": 1, "key":');
    mkdirSync(join(ledgerDir(repo), "folder.json"));

    assert.equal(nearest()?.findings[0]?.reason, "Kept.");
  });
});

describe("renderReport", () => {
  it("lists every finding with its status and its test or reason, with pipes escaped", () => {
    const ledger = record([finding({ summary: "a | b" }), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })], 2);

    const report = renderReport(ledger);

    assert.match(report, /2 round\(s\), 2 finding\(s\)/);
    assert.match(report, /\| R1 \| Edge cases \| app\.cs:3 \| a \\\| b \| fixed \| tests\/AppTests\.cs::Guard_WhitespaceEmail_Fails \|/);
    assert.match(report, /\| R2 .* \| accepted \| Spec\. \|/);
  });

  it("shows which findings are marked security, so a person can see what the notes will leave out", () => {
    const report = renderReport(record([finding({ security: true }), finding({ id: "R2" })]));

    assert.match(report, /\| R1 \| Edge cases \(security\) \|/);
    assert.match(report, /\| R2 \| Edge cases \|/);
  });

  it("shows a stored finding with no security mark as security, as the notes treat it", () => {
    const { security: _, ...unmarked } = finding();
    const ledger: Ledger = { ...record([]), findings: [unmarked] };

    assert.match(renderReport(ledger), /\| R1 \| Edge cases \(security\) \|/);
  });

  it("says there were no findings when a review found nothing", () => {
    const report = renderReport(record([]));

    assert.match(report, /0 finding\(s\)/);
    assert.match(report, /No findings\./);
  });

  it("can't mention anyone or hide text in a tag", () => {
    const ledger = record([finding({ status: "accepted", test: null, summary: "Uses <details> <!-- x -->.", reason: "@someone agreed." })]);

    const report = renderReport(ledger);

    assert.doesNotMatch(report, /<details>|<!--|@someone/);
    assert.match(report, /&lt;details>/);
  });

  it("keeps a path's mentions, references and pipes from doing anything", () => {
    const ledger = record([finding({ path: "src/@someone/a|b#12.cs", status: "accepted", test: null, reason: "Fine." })]);

    const row = renderReport(ledger).split("\n").find((line) => line.startsWith("| R1")) ?? "";
    const notes = renderReviewNotes(ledger);

    assert.equal(row.split(/(?<!\\)\|/).length, 8);
    assert.doesNotMatch(row, /@someone|#12/);
    assert.doesNotMatch(notes, /@someone|#12/);
  });

  it("names HEAD when the review was recorded on a detached HEAD", () => {
    const ledger: Ledger = { ...record([]), branch: "" };

    assert.match(renderReport(ledger), /^Review of HEAD at /);
  });

  it("keeps each finding on one row, whatever its text holds", () => {
    const ledger = record([finding({ summary: "first line\nsecond line \\| still one cell" })]);

    const rows = renderReport(ledger).split("\n").filter((line) => line.startsWith("| R1"));

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.split(/(?<!\\)\|/).length, 8);
  });
});

describe("renderReviewNotes", () => {
  it("lists only the accepted findings, under the heading the PR description uses", () => {
    const ledger = record([finding(), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /^<!-- review-notes -->\n## Review notes\n/);
    assert.match(notes, /Accepted: Spec\./);
    assert.doesNotMatch(notes, /Guard_WhitespaceEmail_Fails/);
  });

  it("counts accepted security findings without listing them, whichever lens raised them, since the notes become public", () => {
    const ledger = record([
      finding({ status: "accepted", test: null, lens: "GitHub Actions", security: true, summary: "A fork reaches the token.", reason: "Later." }),
      finding({ id: "R2", status: "accepted", test: null, lens: "Edge/Security", summary: "The token reaches the log.", reason: "Later." }),
      finding({ id: "R3", status: "accepted", test: null, reason: "Spec." }),
    ]);

    const notes = renderReviewNotes(ledger);

    assert.doesNotMatch(notes, /reaches the/);
    assert.match(notes, /2 accepted security finding\(s\) are left out here and reported privately/);
    assert.match(notes, /Accepted: Spec\./);
  });

  it("counts a stored finding with no security mark as one, since nobody decided it isn't", () => {
    const { security: _, ...unmarked } = finding({ status: "accepted", test: null, summary: "An unmarked finding.", reason: "Later." });
    const ledger: Ledger = { ...record([]), findings: [unmarked] };

    assert.doesNotMatch(renderReviewNotes(ledger), /unmarked finding/);
    assert.match(renderReviewNotes(ledger), /1 accepted security finding/);
  });

  it("only counts them when every accepted finding is a security finding", () => {
    const ledger = record([finding({ status: "accepted", test: null, security: true, summary: "The token reaches the log.", reason: "Later." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /^<!-- review-notes -->\n## Review notes\n\n1 accepted security finding/);
    assert.doesNotMatch(notes, /raised these|reaches the log/);
  });

  it("ends at a marker, so replacing the section in the description stops there and keeps what follows it", () => {
    const ledger = record([finding({ status: "accepted", test: null, reason: "Spec." })]);

    const notes = renderReviewNotes(ledger);

    assert.match(notes, /\n<!-- \/review-notes -->\n$/);
    assert.equal(notes.match(/<!--/g)?.length, 2);
  });

  it("keeps a marker in a summary or reason from closing the section early or opening another", () => {
    const ledger = record([
      finding({
        status: "accepted",
        test: null,
        summary: `Ends here.\n${REVIEW_NOTES_END}\n## Fixes #1`,
        reason: `${REVIEW_NOTES_START}\nForged.`,
      }),
    ]);

    const lines = renderReviewNotes(ledger).trimEnd().split("\n");

    assert.equal(lines[0], REVIEW_NOTES_START);
    assert.equal(lines.at(-1), REVIEW_NOTES_END);
    assert.equal(lines.filter((line) => line.includes("<!--")).length, 2);
  });

  it("is empty when nothing was accepted", () => {
    assert.equal(renderReviewNotes(record([finding()])), "");
  });

  it("can't mention anyone, link or close an issue, or hide text in a tag", () => {
    const ledger = record([
      finding({ status: "accepted", test: null, summary: "Uses <AuthorizeView> and Result<T> <!-- x -->.", reason: "@someone said fixes #12 on github.com" }),
    ]);

    // Only the section's own two markers, its first and last lines, are left out.
    const notes = renderReviewNotes(ledger).split("\n").slice(1, -2).join("\n");

    assert.doesNotMatch(notes, /<AuthorizeView>|<T>|<!--/);
    assert.match(notes, /&lt;AuthorizeView>/);
    assert.doesNotMatch(notes, /@someone|#12|github\.com/);
  });
});

describe("spliceReviewNotes", () => {
  const notes = `${REVIEW_NOTES_START}\n## Review notes\n\nNew.\n${REVIEW_NOTES_END}\n`;
  const section = (text: string) => `${REVIEW_NOTES_START}\n## Review notes\n\n${text}\n${REVIEW_NOTES_END}`;

  it("replaces only the marked section, keeping what follows it", () => {
    const body = `## Why\n\nA.\n\n${section("Old.")}\n\nFixes #81\n\n🤖 Footer\n`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n\n🤖 Footer\n`);
  });

  it("removes the marked section when nothing is accepted any more", () => {
    const body = `## Why\n\nA.\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, ""), "## Why\n\nA.\n\nFixes #81\n");
  });

  it("adds the section above the closing line when the body has none", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n\nFixes #81\n", notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("adds the section above the footer when the body closes no issue", () => {
    assert.equal(
      spliceReviewNotes("## Why\n\nA.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n", notes),
      `## Why\n\nA.\n\n${section("New.")}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`,
    );
  });

  it("adds the section at the end of a body with neither", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n", notes), `## Why\n\nA.\n\n${section("New.")}\n`);
  });

  it("leaves a body with no section and no notes as it is", () => {
    assert.equal(spliceReviewNotes("## Why\n\nA.\n", ""), "## Why\n\nA.\n");
  });

  it("takes a marker only as a line of its own, not one quoted in the text", () => {
    const body = `## What changed\n\nWraps it in \`${REVIEW_NOTES_START}\` and \`${REVIEW_NOTES_END}\`.\n\n${section("Old.")}\n\nFixes #81\n`;

    assert.equal(
      spliceReviewNotes(body, notes),
      `## What changed\n\nWraps it in \`${REVIEW_NOTES_START}\` and \`${REVIEW_NOTES_END}\`.\n\n${section("New.")}\n\nFixes #81\n`,
    );
  });

  it("finds the markers in a body GitHub stored with CRLF line endings", () => {
    const body = `## Why\r\n\r\nA.\r\n\r\n${section("Old.").replaceAll("\n", "\r\n")}\r\n\r\nFixes #81\r\n`;

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("removes a section at the end of the body with the blank line before it", () => {
    assert.equal(spliceReviewNotes(`## Why\n\nA.\n\n${section("Old.")}\n`, ""), "## Why\n\nA.\n");
  });

  it("gives back the body it added a section to once the section is removed", () => {
    for (const body of ["## Why\n\nA.\n", "## Why\n\nA.\n\nFixes #81\n", "## Why\n\nA.\n\n🤖 Generated with x\n"]) {
      assert.equal(spliceReviewNotes(spliceReviewNotes(body, notes), ""), body);
    }
  });

  it("adds the section above the closing line, not the footer below it", () => {
    assert.equal(
      spliceReviewNotes("## Why\n\nA.\n\nFixes #81\n\n🤖 Generated with x\n", notes),
      `## Why\n\nA.\n\n${section("New.")}\n\nFixes #81\n\n🤖 Generated with x\n`,
    );
  });

  for (const closing of ["Closes #4", "resolves #4"]) {
    it(`takes "${closing}" as the closing line too`, () => {
      assert.equal(spliceReviewNotes(`## Why\n\nA.\n\n${closing}\n`, notes), `## Why\n\nA.\n\n${section("New.")}\n\n${closing}\n`);
    });
  }

  it("takes the last closing line that starts a paragraph, not one quoted earlier or wrapped into a sentence", () => {
    const body = "## Why\n\nFixes #12 was\nresolves #40 too.\n\nFixes #12\nalso.\n\nFixes #81\n";

    assert.equal(spliceReviewNotes(body, notes), `## Why\n\nFixes #12 was\nresolves #40 too.\n\nFixes #12\nalso.\n\n${section("New.")}\n\nFixes #81\n`);
  });

  it("ignores markers, a heading and a closing line shown in a code block", () => {
    const example = `\`\`\`markdown\n${section("Example.")}\n## Review notes\nFixes #1\n\`\`\``;
    const body = `## What changed\n\n${example}\n\nFixes #81\n`;

    assert.equal(spliceReviewNotes(body, notes), `## What changed\n\n${example}\n\n${section("New.")}\n\nFixes #81\n`);
    assert.equal(spliceReviewNotes(`${body.replace("Fixes #81\n", "")}${section("Old.")}\n\nFixes #81\n`, ""), body);
  });

  it("ends the result in one newline, however many the body ended in", () => {
    const once = spliceReviewNotes("## Why\n\nA.\n", notes);

    assert.equal(spliceReviewNotes(`${once}\n\n`, notes), once);
  });

  for (const [shape, body] of [
    ["an empty body", ""],
    ["a body of only whitespace", " \n\n"],
    ["a Review notes heading indented and closed with hashes", "## Why\n\n   ## Review notes ##\n\nOld.\n"],
    ["a Review notes heading in emphasis with a colon", "## Why\n\n## **Review notes:**\n\nOld.\n"],
    ["a setext Review notes heading", "## Why\n\nReview notes\n---\n\nOld.\n"],
    ["an HTML Review notes heading", "## Why\n\n<h2>Review notes</h2>\n\nOld.\n"],
    ["two marked sections", `${section("A.")}\n\n${section("B.")}\n`],
    ["a start marker with no end", `${REVIEW_NOTES_START}\n## Review notes\n\nFixes #81\n`],
    ["an end marker before the start", `${REVIEW_NOTES_END}\n\n${REVIEW_NOTES_START}\n`],
    ["a Review notes section written before the markers", "## Why\n\nA.\n\n## Review notes\n\nOld.\n\nFixes #81\n"],
  ] as const) {
    it(`refuses a body with ${shape}, rather than guess where the section ends`, () => {
      assert.throws(() => spliceReviewNotes(body, notes), /ask the person/);
    });
  }
});

describe("main", () => {
  it("check exits 1 with no review recorded, and 0 once a clean one is", () => {
    assert.equal(cli(["check"]).code, 1);

    record([]);

    assert.equal(cli(["check"]).code, 0);
  });

  it("check exits 1 when there is no origin/main to diff against", () => {
    run(repo, "remote", "remove", "origin");

    const result = cli(["check"]);

    assert.equal(result.code, 1);
    assert.match(result.err, /git fetch origin main/);
  });

  it("check uses the base it's given", () => {
    record([]);
    const base = mergeBase(repo);
    run(repo, "remote", "remove", "origin");

    assert.equal(cli(["check", base]).code, 0);
  });

  it("prepare writes the diff the reviewers read and prints the key record expects", () => {
    const dir = join(root, "run");

    const result = cli(["prepare", dir]);

    assert.equal(result.code, 0);
    assert.deepEqual(result.out.trim().split("\n"), [diffKey(repo, mergeBase(repo)), run(repo, "rev-parse", "HEAD")]);
    assert.match(readFileSync(join(dir, "diff.patch"), "utf8"), /^\+changed$/m);
  });

  for (const dir of ["", "relative/run"]) {
    it(`prepare refuses a folder that isn't absolute: ${JSON.stringify(dir)}`, () => {
      assert.equal(cli(["prepare", dir]).code, 1);
    });
  }

  it("accept stores every word of the reason", () => {
    record([finding({ status: "open", test: null })]);

    assert.equal(cli(["accept", "R1", "two", "words"]).code, 0);

    assert.equal(readLedger(repo, diffKey(repo, mergeBase(repo)))?.findings[0]?.reason, "two words");
  });

  it("body writes the PR description from a file with its Review notes section replaced", () => {
    record([finding({ status: "accepted", test: null, reason: "Spec." })]);
    const input = join(root, "old-body.md");
    const output = join(root, "body.md");
    writeFileSync(input, "## Why\n\nA.\n\nFixes #81\n");

    const result = cli(["body", input, output]);

    assert.equal(result.code, 0, result.err);
    assert.match(readFileSync(output, "utf8"), /^## Why\n\nA\.\n\n<!-- review-notes -->\n## Review notes\n[\s\S]*Accepted: Spec\.\n<!-- \/review-notes -->\n\nFixes #81\n$/);
  });

  // Each leaves no file behind, not even an earlier run's, so a `gh pr edit
  // --body-file` after it fails rather than publish a wrong description.
  for (const [failure, body, recorded] of [
    ["a body it can't splice", "## Review notes\n\nOld.\n", true],
    ["an empty body, as a failed gh pr view leaves", "", true],
    ["no review recorded for the diff", "## Why\n\nA.\n", false],
  ] as const) {
    it(`body fails, and leaves no output file, on ${failure}`, () => {
      if (recorded) record([]);
      const input = join(root, "old-body.md");
      const output = join(root, "body.md");
      writeFileSync(input, body);
      writeFileSync(output, "an earlier run's description\n");

      const result = cli(["body", input, output]);

      assert.equal(result.code, 1);
      assert.equal(existsSync(output), false);
      assert.match(result.err, recorded ? /ask the person/ : /No review is recorded/);
    });
  }

  it("report prints the table and notes prints the Review notes", () => {
    record([finding(), finding({ id: "R2", status: "accepted", test: null, reason: "Spec." })]);

    assert.match(cli(["report"]).out, /\| Id \| Lens \|/);
    assert.match(cli(["notes"]).out, /^<!-- review-notes -->\n## Review notes/);
  });

  it("latest prints the branch's earlier review after a fix commit", () => {
    record([finding({ status: "accepted", test: null, reason: "Kept." })]);
    commit(repo, "app.cs", lines(50, (index) => (index === 2 ? "fix" : undefined)), "fix");

    assert.match(cli(["latest"]).out, /"Kept\."/);
  });

  for (const args of [["bogus"], [], ["record"], ["accept", "R1"], ["body"], ["body", "in.md"], ["body", "in.md", "in.md"], ["body", "in.md", "-"]]) {
    it(`exits 1 with the usage for ${JSON.stringify(args)}`, () => {
      const result = cli(args);

      assert.equal(result.code, 1);
      assert.match(result.err, /Usage: scripts\/review\.sh/);
    });
  }

  it("report and notes exit 1 when no review is recorded", () => {
    assert.equal(cli(["report"]).code, 1);
    assert.equal(cli(["notes"]).code, 1);
  });

  it("record exits 1 with the schema's message on a review that doesn't parse", () => {
    const file = join(root, "review.json");
    writeFileSync(file, JSON.stringify({ ...reviewed(), rounds: 1, findings: [{ id: "X" }] }));

    const result = cli(["record", file]);

    assert.equal(result.code, 1);
    assert.match(result.err, /doesn't parse/);
  });

  it("latest prints {} when there is no earlier review", () => {
    assert.equal(cli(["latest"]).out.trim(), "{}");
  });

  it("next prints the first id this run may use, after every id the branch's reviews took", () => {
    assert.equal(cli(["next"]).out, "R1\n");
    record([finding({ status: "open", test: null }), finding({ id: "R2", status: "open", test: null })]);
    record([]);

    assert.equal(cli(["next"]).out, "R3\n");
  });
});

describe("scripts/review.sh", () => {
  // The gate runs these tests with GATE_SKIP_REVIEW=1 set, which the command
  // would honour.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GATE_SKIP_REVIEW"));
  const script = (cwd: string, ...args: string[]) => spawnSync("bash", [reviewScript, ...args], { cwd, encoding: "utf8", env });

  it("exits 1 on an unreviewed diff, as the gate needs", () => {
    const result = script(repo, "check", mergeBase(repo));

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No review is recorded/);
  });

  it("exits 0 once the diff was reviewed clean", () => {
    record([]);

    assert.equal(script(repo, "check", mergeBase(repo)).status, 0);
  });

  it("records a review read from stdin, as the skill does", () => {
    const input = JSON.stringify({ ...reviewed(), rounds: 1, findings: [] });

    const result = spawnSync("bash", [reviewScript, "record", "-"], { cwd: repo, encoding: "utf8", env, input });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(readLedger(repo, diffKey(repo, mergeBase(repo))));
  });

  it("splices a PR description read from stdin, as gh pr view can pipe it", () => {
    record([]);
    const output = join(root, "body.md");

    const result = spawnSync("bash", [reviewScript, "body", "-", output], { cwd: repo, encoding: "utf8", env, input: "## Why\n\nA.\n" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), "## Why\n\nA.\n");
  });

  it("works when the caller's shell sets CDPATH", () => {
    const result = spawnSync("bash", ["scripts/review.sh", "bogus"], { cwd: repoRoot, encoding: "utf8", env: { ...env, CDPATH: "." } });

    assert.match(result.stderr, /Usage: scripts\/review\.sh/);
  });

  // A copy of scripts/review.sh in a checkout with no packages, and a stub
  // pnpm (or none) on a PATH of its own. The stub logs its arguments; "works"
  // creates tsx, "no-tsx" succeeds without creating it, "fails" exits 1.
  function bareCheckout(pnpm: "works" | "no-tsx" | "fails" | "missing") {
    const checkout = join(root, "bare");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    const script = join(checkout, "scripts", "review.sh");
    writeFileSync(script, readFileSync(reviewScript, "utf8"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["dirname", "mkdir", "chmod", "printf"]) {
      symlinkSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    }
    const log = join(root, "pnpm.log");
    const makeTsx = `mkdir -p "${checkout}/node_modules/.bin"\nprintf '#!/bin/sh\\necho "tsx $*"\\n' > "${checkout}/node_modules/.bin/tsx"\nchmod +x "${checkout}/node_modules/.bin/tsx"\n`;
    if (pnpm !== "missing") {
      const body = { works: `echo installing\n${makeTsx}`, "no-tsx": "echo installing\n", fails: "exit 1\n" }[pnpm];
      writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "${log}"\n${body}`);
      execFileSync("chmod", ["+x", join(bin, "pnpm")]);
    }
    const shell = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const runScript = (command: string) => spawnSync(shell, [script, command], { cwd: repo, encoding: "utf8", env: { ...env, PATH: bin } });
    return { checkout, log, runScript };
  }

  it("installs the packages when tsx is missing, as the re-Apply's fresh worktree needs, keeping stdout for the command", () => {
    const { checkout, log, runScript } = bareCheckout("works");

    const result = runScript("key");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, "utf8").trim(), `--dir ${checkout} install --frozen-lockfile`);
    assert.match(result.stderr, /installing/);
    assert.match(result.stdout, /^tsx .*review-ledger\.mts key$/m);
    assert.doesNotMatch(result.stdout, /installing/);
  });

  for (const pnpm of ["fails", "no-tsx"] as const) {
    it(`fails when the install ${pnpm === "fails" ? "fails" : "leaves no tsx"}`, () => {
      const result = bareCheckout(pnpm).runScript("check");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found after pnpm install/);
    });
  }

  it("says to enable pnpm when it isn't installed", () => {
    const result = bareCheckout("missing").runScript("check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /corepack enable pnpm/);
  });

  it("runs the command through a symlinked path to the module too", () => {
    const link = join(root, "link.mts");
    symlinkSync(moduleFile, link);

    const result = spawnSync(join(repoRoot, "node_modules/.bin/tsx"), [link, "check", mergeBase(repo)], { cwd: repo, encoding: "utf8", env });

    assert.equal(result.status, 1, result.stderr);
  });
});

describe("OWNED_PATHS", () => {
  const rule = () => readFileSync(join(repoRoot, ".claude/rules/baseline.md"), "utf8");
  const section = (from: string, to: string) => rule().slice(rule().indexOf(from), rule().indexOf(to));
  const named = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

  it("lists exactly the Owned files .claude/rules/baseline.md names", () => {
    const owned = named(section("## Owned files", "When a task needs an Owned file"));

    assert.deepEqual([...OWNED_PATHS].sort(), [...new Set(owned)].sort());
  });

  it("leaves out exactly the files under an Owned pattern that .claude/rules/baseline.md calls this repository's own", () => {
    const own = named(section("## Not from the Template", "## Owned files")).filter(underOwnedPattern);

    assert.deepEqual([...NOT_OWNED].sort(), own.sort());
    for (const path of own) assert.equal(isOwnedPath(path), false, path);
  });

  it("matches folders and globs as the rule means them", () => {
    for (const path of [".github/workflows/ci.yml", ".github/hooks/tests/pre-push.test.sh", ".github/scripts/a/b/c.sh", "global.json"]) {
      assert.equal(isOwnedPath(path), true, path);
    }
    for (const path of [
      ".github/workflows/sandcastle.yml",
      ".github/workflows/copilot-review-sync.yml",
      "scripts/tests/check-git-hooks.test.sh",
      ".github/workflows/nested/ci.yml",
      ".github/instructions/a/b.md",
      ".github/ci/gate-checks.sh",
      "scripts/review.sh",
      "scripts/gate.shx",
      "global.json.bak",
      "globalxjson",
      "xglobal.json",
    ]) {
      assert.equal(isOwnedPath(path), false, path);
    }
  });
});

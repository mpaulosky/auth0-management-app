import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// .github/ci/gate-checks.sh's local review check, run for real in a scratch
// repository whose scripts/review.sh is a stub that logs its arguments and
// exits with REVIEW_EXIT. The hook tests in .github/hooks/tests (Owned by the
// Baseline) replace this file with a stub, so nothing else runs it.
// Only the config each test sets, not the machine's (see review-ledger.test.mts).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const gateChecks = fileURLToPath(new URL("../../.github/ci/gate-checks.sh", import.meta.url));

let repo: string;
let log: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-checks-")));
  log = join(repo, "review-calls.log");
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
  run("init", "--quiet", "-b", "main");
  mkdirSync(join(repo, ".github/ci"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  copyFileSync(gateChecks, join(repo, ".github/ci/gate-checks.sh"));
  writeFileSync(join(repo, "scripts/review.sh"), `#!/usr/bin/env bash\necho "$*" >> '${log}'\nexit "\${REVIEW_EXIT:-0}"\n`);
  chmodSync(join(repo, "scripts/review.sh"), 0o755);
  run("add", ".");
  run("commit", "--quiet", "-m", "start");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// Run the checks with `base` as their merge base. HEAD is the base, so no
// other check has anything to do.
function gate(base: string, env: NodeJS.ProcessEnv = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GATE_SKIP_REVIEW"));
  return spawnSync("bash", [".github/ci/gate-checks.sh", base], { cwd: repo, encoding: "utf8", env: { ...clean, ...env } });
}

const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

describe("gate-checks.sh's local review check", () => {
  it("asks scripts/review.sh to check the diff against the merge base it was given", () => {
    const result = gate(head());

    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls(), `check ${head()}\n`);
  });

  it("fails the gate when the review check fails", () => {
    const result = gate(head(), { REVIEW_EXIT: "1" });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Copilot review/);
  });

  it("fails the gate when there's no origin/main to diff against", () => {
    const result = gate("");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /git fetch origin main/);
    assert.equal(calls(), "");
  });

  it("skips the check, and runs the other checks, when GATE_SKIP_REVIEW is 1", () => {
    const result = gate(head(), { GATE_SKIP_REVIEW: "1", REVIEW_EXIT: "1" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local review check skipped/);
    assert.match(result.stdout, /No Copilot review sync changes to check/);
    assert.match(result.stdout, /No Sandcastle or package changes to check/);
    assert.equal(calls(), "");
  });

  it("reruns the Sandcastle check when .claude/rules/baseline.md changes, since a test keeps the Owned list in step with it", () => {
    const base = head();
    mkdirSync(join(repo, ".claude/rules"), { recursive: true });
    writeFileSync(join(repo, ".claude/rules/baseline.md"), "# Baseline\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "rule"], { cwd: repo });
    const bin = join(repo, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    const result = gate(base, { GATE_SKIP_REVIEW: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });

    assert.match(result.stdout, /Sandcastle TypeScript check/);
    assert.match(calls(), /^run check:sandcastle$/m);
  });

  it("reruns the Sandcastle check when README.md changes, since readme.test.mts guards the Releases section", () => {
    // Arrange
    const base = head();
    writeFileSync(join(repo, "README.md"), "# Readme\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "readme"], { cwd: repo });
    const bin = join(repo, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    // Act
    const result = gate(base, { GATE_SKIP_REVIEW: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });

    // Assert
    assert.match(result.stdout, /Sandcastle TypeScript check/);
    assert.match(calls(), /^run check:sandcastle$/m);
  });

  it("doesn't skip the check for any other value of GATE_SKIP_REVIEW", () => {
    const result = gate(head(), { GATE_SKIP_REVIEW: "true", REVIEW_EXIT: "1" });

    assert.notEqual(result.status, 0);
    assert.equal(calls(), `check ${head()}\n`);
  });
});

// A gh command that names no repository reaches the clone's default one, which
// in a fork's clone is the fork.
describe("gate-checks.sh's gh repository check", () => {
  // Commit `content` at `file`, then run the checks with the review skipped.
  function gateWith(file: string, content: string) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "gh"], { cwd: repo });
    return gate(head(), { GATE_SKIP_REVIEW: "1" });
  }

  for (const [file, line] of [
    ["scripts/watch.sh", 'gh pr checks "$pr" --json name'],
    ["scripts/watch.sh", "  data=$(gh issue view 3)"],
    [".claude/skills/a/SKILL.md", "Read it with `gh issue view <n> --json comments`."],
    [".claude/skills/a/SKILL.md", "Run `gh api repos/{owner}/{repo}/issues/3`."],
    [".claude/skills/a/SKILL.md", "Run `gh api repos/:owner/:repo/pulls`."],
    ["scripts/watch.sh", 'repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"'],
    ["scripts/watch.sh", 'gh pr view "$pr" --repo "$repo" --json body; gh pr checks "$pr" --json bucket'],
    [".claude/skills/a/SKILL.md", "Read it with `gh pr view <n> --repo o/r --json body` and edit it with `gh pr edit <n> --body-file x`."],
    ["scripts/watch.sh", "cp -R a b && gh pr view 3"],
    ["scripts/watch.sh", "gh pr checks 3 | grep -R x ."],
    ["scripts/watch.sh", "gh pr checks 3  # add --repo later"],
    [".claude/skills/a/SKILL.md", "Run `gh pr checks 3`, then `gh pr view 3 --repo o/r`."],
    ["scripts/watch.sh", 'gh pr checks "$pr"; gh pr view "$pr" --repo "$repo"'],
    ["scripts/watch.sh", "gh pr checks 3 && gh pr view 3 -R o/r"],
    ["scripts/watch.sh", "a=$(gh pr checks 3) b=$(gh pr view 3 --repo o/r)"],
    ["scripts/watch.sh", `gh pr view "$(gh pr list --repo o/r --head b --json number -q '.[0].number')" --json body`],
    [".claude/skills/a/SKILL.md", "Run `gh repo view` first."],
    ["scripts/watch.sh", 'name="$(gh repo view)"'],
    ["scripts/watch.sh", "gh repo view | head"],
    ["scripts/watch.sh", "gh repo view; echo"],
    ["scripts/watch.sh", "if gh repo view >/dev/null 2>&1; then"],
    ["scripts/watch.sh", "gh repo view 2>/dev/null"],
    ["scripts/watch.sh", 'gh pr comment 3 --body "use --repo o/r"'],
    ["scripts/watch.sh", "gh issue create --title x --body '-R o/r'"],
    ["scripts/watch.sh", "gh pr checks 3  # the check needs gh pr view too"],
  ]) {
    it(`fails on a command that names no repository: ${line}`, () => {
      const result = gateWith(file ?? "", `first\n${line}\n`);

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${(file ?? "").replace(/\./g, "\\.")}:2:`));
      assert.match(result.stderr, /--repo/);
    });
  }

  for (const [file, line] of [
    ["scripts/watch.sh", 'gh pr checks "$pr" --repo "$repo" --json name'],
    ["scripts/watch.sh", "gh issue view 3 -R mpaulosky/auth0-management-app"],
    ["scripts/watch.sh", "gh pr view 3 --repo=mpaulosky/auth0-management-app"],
    ["scripts/watch.sh", "# gh pr checks exits non-zero when a check failed"],
    [".claude/skills/a/SKILL.md", "`gh api repos/mpaulosky/auth0-management-app/issues/3`"],
    [".claude/skills/a/SKILL.md", "`gh api graphql -F owner=mpaulosky -F name=auth0-management-app`"],
    ["docs/notes.md", "gh pr view 3"],
    ["scripts/watch.sh", 'repo="$(gh repo view mpaulosky/auth0-management-app --json nameWithOwner)"'],
    ["scripts/watch.sh", 'gh pr view "$pr" --repo "$repo" --json body; gh pr checks "$pr" -R "$repo"'],
    ["scripts/watch.sh", `gh pr list --jq '.[] | .number' --repo o/r`],
    ["scripts/watch.sh", 'gh pr comment 3 --body "see #12; it (works) & more" --repo o/r'],
    ["scripts/watch.sh", 'gh issue create --title "fix(review): x" --repo o/r'],
    ["scripts/watch.sh", 'gh pr view "$(git branch --show-current)" --repo "$repo"'],
    ["scripts/watch.sh", "gh pr view $(git branch --show-current) --repo o/r"],
    ["scripts/watch.sh", 'gh repo view "$repo" --json name'],
    [".claude/skills/a/SKILL.md", "Search gh issues by label."],
    [".claude/skills/a/SKILL.md", "Walk through pr review first."],
    ["scripts/watch.sh", "retry=3  # gh pr checks exits 8 when pending"],
    ["scripts/watch.sh", 'echo "# not a comment" && gh pr view 3 --repo o/r'],
    [".claude/skills/a/SKILL.md", "Run `gh repo view <owner>/<repo> --json name`."],
    [".claude/skills/a/SKILL.md", "Every `gh issue` and `gh pr` command names the repository with `--repo`."],
  ]) {
    it(`passes a command that names its repository, a comment, or a file outside the checked folders: ${line}`, () => {
      const result = gateWith(file ?? "", `${line}\n`);

      assert.equal(result.status, 0, result.stderr);
    });
  }

  it("tells how to name the repository for gh repo view, which has no --repo flag", () => {
    const result = gateWith("scripts/watch.sh", "gh repo view --json name\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /for gh repo view, give the repository as its first argument/);
  });

  it("tells how to name the repository in a gh api path, since gh api has no --repo flag", () => {
    const result = gateWith(".claude/skills/a/SKILL.md", "Run `gh api repos/{owner}/{repo}/issues/3`.\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /for gh api, write it in the path: repos\/mpaulosky\/auth0-management-app\//);
  });

  it("cuts a Markdown line at no #, since there it starts a heading or a reference, not a comment", () => {
    const result = gateWith(".claude/skills/a/SKILL.md", "See #12, then run gh pr view 3.\n");

    assert.equal(result.status, 1);
  });

  it("fails the gate when the files to check can't be listed, rather than pass having checked none", () => {
    writeFileSync(join(repo, ".git/index"), "not an index");

    const result = gate(head(), { GATE_SKIP_REVIEW: "1" });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Every gh command names its repository/);
  });

  it("reads a command continued over lines as one", () => {
    const result = gateWith("scripts/watch.sh", 'gh pr checks "$pr" \\\n  --repo "$repo"\n');

    assert.equal(result.status, 0, result.stderr);
  });

  it("doesn't join a shell comment that ends in a backslash with the next line, as bash doesn't", () => {
    const result = gateWith("scripts/watch.sh", "# a note \\\ngh pr view 3\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/watch\.sh:2:/);
  });

  it("skips a tracked file deleted from the worktree, rather than stop the gate", () => {
    gateWith("scripts/gone.sh", "echo\n");
    rmSync(join(repo, "scripts/gone.sh"));

    const result = gate(head(), { GATE_SKIP_REVIEW: "1" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Every gh command names its repository/);
  });

  it("checks a file whose name holds a space", () => {
    const result = gateWith(".claude/skills/a b/SKILL.md", "gh pr view 3\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a b\/SKILL\.md:1:/);
  });
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { NOT_OWNED, OWNED_PATHS } from "./review-ledger.mts";

// .github/ci/gate-checks.sh's local review check and gh repository check, and
// the reruns of the Sandcastle check, run for real in a scratch
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

// Run the checks with `base` as their merge base. With HEAD as the base, only
// the checks that run on every gate (the review check and the gh repository
// check) have anything to do.
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

  it("reruns the Sandcastle check when scripts/watch-pr.sh changes, since watch-pr.test.mts runs it", () => {
    const base = head();
    writeFileSync(join(repo, "scripts/watch-pr.sh"), "#!/usr/bin/env bash\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "watch"], { cwd: repo });
    const bin = join(repo, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    const result = gate(base, { GATE_SKIP_REVIEW: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });

    assert.match(result.stdout, /Sandcastle TypeScript check/);
    assert.match(calls(), /^run check:sandcastle$/m);
  });

  it("reruns the Sandcastle check when CLAUDE.md changes, since pre-push-review-skill.test.mts reads it", () => {
    // Arrange
    const base = head();
    writeFileSync(join(repo, "CLAUDE.md"), "# Claude\n");
    // A change to CLAUDE.md also runs the git hooks check's test first.
    mkdirSync(join(repo, "scripts/tests"));
    writeFileSync(join(repo, "scripts/tests/check-git-hooks.test.sh"), "exit 0\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "claude"], { cwd: repo });
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

  // status.test.mts reads the Sandcastle plan, and config.test.mts the
  // workflow's name.
  for (const file of ["docs/plans/sandcastle-workflow.md", ".github/workflows/sandcastle.yml"]) {
    it(`reruns the Sandcastle check when ${file} changes, since a Sandcastle test reads it`, () => {
      // Arrange
      const base = head();
      mkdirSync(join(repo, file, ".."), { recursive: true });
      writeFileSync(join(repo, file), "changed\n");
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "file"], { cwd: repo });
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
  }

  it("doesn't skip the check for any other value of GATE_SKIP_REVIEW", () => {
    const result = gate(head(), { GATE_SKIP_REVIEW: "true", REVIEW_EXIT: "1" });

    assert.notEqual(result.status, 0);
    assert.equal(calls(), `check ${head()}\n`);
  });
});

// A gh command reaches gh's default repository unless it's told which one,
// and in a clone whose only remote is a fork that's the fork. GH_REPO tells
// every gh command but gh repo's subcommands, which take the repository as
// their argument.
describe("gate-checks.sh's gh repository check", () => {
  // Commit `content` at `file`, then run the checks with the review skipped.
  function gateWith(file: string, content: string) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "gh"], { cwd: repo });
    return gate(head(), { GATE_SKIP_REVIEW: "1" });
  }

  const skill = ".claude/skills/a/SKILL.md";
  const script = "scripts/watch.sh";
  const exported = 'export GH_REPO="${GH_REPO:-mpaulosky/auth0-management-app}"\n';

  for (const [file, content] of [
    [skill, "Read it with `gh issue view <n> --json comments`.\n"],
    [skill, "Run `gh api repos/{owner}/{repo}/issues/3`.\n"],
    [skill, "Every `gh issue` and `gh pr` command.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh pr view 3` and then `gh pr checks 3`.\n"],
    [skill, "Run `GH_REPO= gh pr view 3`.\n"],
    [`.claude/skills/a/notes.txt`, "then run gh run list\n"],
    [script, "#!/usr/bin/env bash\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\ngh pr checks 3\nexport GH_REPO=mpaulosky/auth0-management-app\n"],
    [script, "#!/usr/bin/env bash\necho 'export GH_REPO=x'\ngh pr checks 3\n"],
    [script, `#!/usr/bin/env bash\n${exported}gh repo view --json name\n`],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo edit --description x`.\n"],
    [skill, "Read it with `gh\npr view 3`.\n"],
    [skill, "Read it with `GH_REPO=mpaulosky/auth0-management-app gh\npr view 3`.\n"],
    [skill, "Read it with `gh  pr view 3`.\n"],
    [skill, "Read it with `gh\tpr view 3`.\n"],
    [skill, "Read it with `gh \\\n  pr view 3`.\n"],
    [skill, "Read it with `gh --repo o/r pr view 3`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app; gh pr view 3`.\n"],
    [skill, "Set GH_REPO=mpaulosky/auth0-management-app, gh pr view 3.\n"],
    [skill, "Run `NOT_GH_REPO=mpaulosky/auth0-management-app gh pr view 3`.\n"],
    [skill, 'Run `GH_REPO="" gh pr view 3`.\n'],
    [skill, "Run `GH_REPO='' gh pr view 3`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app echo x && gh pr view 3`.\n"],
    [skill, "export GH_REPO=mpaulosky/auth0-management-app\nRun `gh pr view 3`.\n"],
    [script, '#!/usr/bin/env bash\nexport GH_REPO=""\ngh pr checks 3\n'],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=''\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=;\ngh pr checks 3\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view 2>/dev/null`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view &>/dev/null`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view >/tmp/out`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo \\\n  view --json name`.\n"],
    [skill, 'Run `GH_REPO=mpaulosky/auth0-management-app gh repo "$sub" o/r`.\n'],
    [script, `#!/usr/bin/env bash\n${exported}gh repo\n`],
    [script, `#!/usr/bin/env bash\n${exported}gh repo \\\n  view --json name\n`],
    [script, `#!/usr/bin/env bash\n${exported}gh \\\n  repo view\n`],
    [skill, "Read it with `gh\\\n  pr view 3`.\n"],
    [script, `#!/usr/bin/env bash\n${exported}gh\\\n  repo view\n`],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh  repo view --json name`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh\trepo view --json name`.\n"],
    [script, `#!/usr/bin/env bash\n${exported}gh\trepo view --json name\n`],
    ...["`", "&", "|", "(", ")", "<", ">", '"', "'"].flatMap((c) => [
      [skill, `Run \`GH_REPO=mpaulosky/auth0-management-app${c} gh pr view 3\`.\n`],
      [script, `#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app${c}\ngh pr checks 3\n`],
    ]),
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app; echo hi\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app && echo hi\ngh pr checks 3\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo.`\n"],
    // --repo and -R name the repository after the command group or the
    // subcommand, never for gh api, which has neither, and only for their own
    // gh command.
    [skill, "Run `gh api repos/{owner}/{repo}/pulls --repo o/r`.\n"],
    [skill, 'Run `gh pr view 3 --repo ""`.\n'],
    [skill, "Run `gh pr view 3 --repo`.\n"],
    [skill, "Run `gh pr view 3 --repository o/r`.\n"],
    [skill, "Run `gh pr view 3; gh pr checks 3 --repo o/r`.\n"],
    [skill, "Run `gh pr view 3` and then `gh pr checks 3 -R o/r`.\n"],
    [skill, "Run `gh pr view 3 && GH_REPO=o/r gh pr checks 3 --repo o/r`.\n"],
    // A quoted argument that holds the flag's words isn't the flag.
    [skill, 'Run `gh pr comment 3 --body "use -R foo now"`.\n'],
    [skill, "Run `gh issue create --title 'fix --repo handling now'`.\n"],
    [skill, "Run `gh pr view 3 --repo ''`.\n"],
    // ...however the quoted argument ends, and an empty one is no value.
    [skill, 'Run `gh pr comment 3 --body "use -R foo (see docs)"`.\n'],
    [skill, 'Run `gh issue create --title "use --repo x; fine"`.\n'],
    [skill, 'Run `gh pr comment 3 --body "a -R b | c"`.\n'],
    [skill, 'Run `gh pr comment 3 --body "use -R foo`.\n'],
    [skill, "Run `gh pr view 3 --repo '' --json state`.\n"],
    [skill, 'Run `gh pr view 3 -R "" --json state`.\n'],
    // A quote never pairs across a backtick, so an apostrophe in a command
    // and one in later prose don't hide the backtick that ends the command.
    [skill, "Run `gh pr view 3 --body it's` and don't use --repo o/r.\n"],
    [skill, "Run `gh pr view 3 don't` and `x`, it's --repo o/r.\n"],
    // An unpaired apostrophe ends the command, and nothing after a cut quote
    // ends a value, so an escaped quote can't expose a flag.
    [skill, "Run `gh pr comment 3 --body 'use -R foo`.\n"],
    [skill, 'Run `gh pr comment 3 --body "a \\" -R x"`.\n'],
    [skill, "Run `gh issue create --body 'it'\\''s -R x'`.\n"],
    [skill, 'Run `gh pr comment 3 --body "a \\" -R x \\" b"`.\n'],
    [skill, 'Run `gh pr view 3 -R o/r"`.\n'],
    // A comment, and the next gh command, end a command's text.
    [script, "#!/usr/bin/env bash\ngh pr checks 3 # or --repo o/r\n"],
    [skill, "Run `gh pr view 3 # -R o/r`.\n"],
    [skill, "Run gh pr view 3 or gh pr checks 3 --repo o/r.\n"],
    // A backslash before a backtick is no escape, so a code span ending in
    // one still ends there, and inside single quotes a backslash is literal.
    [skill, "Run `gh pr view 3 \\` and add --repo o/r later.\n"],
    [skill, "Run `gh issue create --body 'C:\\' --title ' -R x '`.\n"],
  ]) {
    it(`fails on a gh command not told its repository: ${JSON.stringify(content)} in ${file}`, () => {
      const result = gateWith(file ?? "", content ?? "");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /GH_REPO=mpaulosky\/auth0-management-app/);
      assert.match(result.stderr, /--repo mpaulosky\/auth0-management-app/);
    });
  }

  for (const [file, content] of [
    [skill, "Read it with `GH_REPO=mpaulosky/auth0-management-app gh issue view <n> --json comments`.\n"],
    [skill, "`GH_REPO=mpaulosky/auth0-management-app gh api repos/{owner}/:repo/pulls`\n"],
    [skill, "Run `env GH_REPO=mpaulosky/auth0-management-app gh run list`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view mpaulosky/auth0-management-app --json name`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view <owner>/<repo>`.\n"],
    [skill, 'Run `GH_REPO=mpaulosky/auth0-management-app gh repo view "$repo"`.\n'],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo rename -R o/r new`.\n"],
    [skill, "Run `gh repo list mpaulosky` or `gh repo clone o/r`.\n"],
    [skill, "The `gh` CLI, and a high gh.\n"],
    [skill, "# A heading about gh pr view\n"],
    [script, `#!/usr/bin/env bash\n${exported}gh pr checks "$pr" --json bucket\ngh api "repos/\${repo}/pulls"\n`],
    [script, `#!/usr/bin/env bash\n# gh pr checks is used below\n${exported}gh pr checks 3\n`],
    [script, "#!/usr/bin/env bash\necho done\n"],
    ["docs/notes.md", "gh pr view 3\n"],
    [skill, 'Run `GH_REPO=mpaulosky/auth0-management-app gh repo view "o/r" --json name`.\n'],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view 'o/r' --json name`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view $repo`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo rename --repo o/r new`.\n"],
    [skill, "Run `gh repo create --public`.\n"],
    [skill, 'Run `GH_REPO="mpaulosky/auth0-management-app" gh pr view 3`.\n'],
    [skill, "That is enough\nor high\nand a high-gh pr view, or a sigh pr.\n"],
    ["scripts/plain.sh", "export GH_REPO=mpaulosky/auth0-management-app\ngh pr checks 3\n"],
    ["scripts/watch", `#!/usr/bin/env bash\n${exported}gh pr checks 3\n`],
    [script, "#!/usr/bin/env bash\nexport GH_REPO='mpaulosky/auth0-management-app'\ngh pr checks 3\n"],
    [script, `#!/usr/bin/env bash\n${exported}command -v gh\nif ! command -v gh; then exit 1; fi\n`],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh  repo view o/r`.\n"],
    [skill, "GH_REPO=mpaulosky/auth0-management-app gh pr view 3\n"],
    [skill, "\tGH_REPO=mpaulosky/auth0-management-app gh pr view 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app;\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app ;\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app  \t\ngh pr checks 3\n"],
    [script, "#!/usr/bin/env bash\nexport GH_REPO=mpaulosky/auth0-management-app # every gh below\ngh pr checks 3\n"],
    [script, '#!/usr/bin/env bash\nexport GH_REPO="$repo"; # every gh below\ngh pr checks 3\n'],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repository view`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo-x view`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo_x view`.\n"],
    [skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo2 view`.\n"],
    [skill, "Run `gh pr view 3 --repo mpaulosky/auth0-management-app`.\n"],
    [skill, "Run `gh issue list -R mpaulosky/auth0-management-app --state open`.\n"],
    [skill, "Run `gh pr checks 3 --repo=mpaulosky/auth0-management-app`.\n"],
    [skill, "Run `gh pr view 3 --repo o/r` and `gh issue view 4 -R o/r`.\n"],
    [script, '#!/usr/bin/env bash\ngh pr checks "$pr" --repo "$repo" --json bucket\n'],
    [skill, "Run `gh pr -R mpaulosky/auth0-management-app view 3`.\n"],
    [skill, "Run `gh run --repo o/r list`.\n"],
    [skill, 'Run `gh pr comment 3 --body "a -R b" --repo o/r`.\n'],
    [skill, "Run `gh pr view 3 --jq '.a[] | .b' --repo o/r`.\n"],
    [skill, 'Run `gh pr view 3 --jq ".a | select(.b == \\"x (y)\\")" --repo o/r`.\n'],
    [skill, 'Run `gh pr comment 3 --body "say \\"hi\\"" --repo o/r`.\n'],
    [skill, "Run `gh issue create --body 'it'\\''s' --repo o/r`.\n"],
    [skill, 'Run `gh pr view 3 --body "a\\\\" -R o/r --title "b"`.\n'],
    [skill, "Run `gh issue create --body it\\'s --repo o/r`.\n"],
    [skill, "Run `gh issue create --body 'C:\\' --repo o/r`.\n"],
    [skill, "Run `gh pr view 3 --repo o/r # note`.\n"],
    [skill, "Run `gh issue create --body a#b --repo o/r`.\n"],
    [skill, "Run `gh pr view 3 --repo o/r`, but don't run it twice.\n"],
  ]) {
    it(`passes a gh command told its repository, or text that runs none: ${JSON.stringify(content)} in ${file}`, () => {
      const result = gateWith(file ?? "", content ?? "");

      assert.equal(result.status, 0, result.stderr);
    });
  }

  it("reads a script's export of GH_REPO for that script only", () => {
    assert.equal(gateWith("scripts/a.sh", `#!/usr/bin/env bash\n${exported}gh pr checks 3\n`).status, 0);

    const result = gateWith("scripts/b.sh", "#!/usr/bin/env bash\ngh pr checks 3\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /scripts\/b\.sh:2:/);
    assert.doesNotMatch(result.stderr, /scripts\/a\.sh/);
  });

  // The Template's own check covers them (mpaulosky/dotfiles#267), and this
  // repository can't change them.
  const ownedScripts = OWNED_PATHS.filter((path) => path.startsWith("scripts/")).map((path) => path.replace("**", "any.test.sh"));
  for (const file of ownedScripts) {
    it(`leaves out the Owned Baseline script ${file}`, () => {
      const result = gateWith(file, "#!/usr/bin/env bash\ngh pr checks 3\n");

      assert.equal(result.status, 0, result.stderr);
    });
  }

  for (const file of [...NOT_OWNED].filter((path) => path.startsWith("scripts/"))) {
    it(`still checks ${file}, which this repository owns under an Owned pattern`, () => {
      const result = gateWith(file, "#!/usr/bin/env bash\ngh pr checks 3\n");

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${file.replaceAll(".", "\\.")}:2:`));
    });
  }

  // The scan ends at a backtick, so it can't read a quoted argument that holds
  // one; the message says how to tell such a command its repository.
  it("refuses a quoted argument holding a backtick, and says to give that command GH_REPO", () => {
    const result = gateWith(skill, "Run `gh pr comment 3 --body 'Fixed in `abc`' --repo o/r`.\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a quoted argument that holds a backtick can't be read here: give that command GH_REPO/);
  });

  // Text in a quoted argument that reads gh and a word counts as a command,
  // which the line's GH_REPO prefix can't tell; the message says to reword it.
  it("refuses a quoted argument that reads as a gh command, and says to reword it", () => {
    const result = gateWith(skill, 'Run `GH_REPO=mpaulosky/auth0-management-app gh pr comment 3 --body "Run gh pr checks"`.\n');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Text in a quoted argument that reads gh and a word counts as a command: reword it/);
  });

  it("names the file and line of each command it refuses", () => {
    const result = gateWith(".claude/skills/a b/SKILL.md", "first\nRun `gh pr view 3`.\n");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a b\/SKILL\.md:2:/);
  });

  it("tells how to name the repository for gh repo's subcommands, which don't read GH_REPO", () => {
    const result = gateWith(skill, "Run `GH_REPO=mpaulosky/auth0-management-app gh repo view`.\n");

    assert.match(result.stderr, /gh repo's subcommands don't read GH_REPO: give the repository as the first argument/);
  });

  it("tells a script to export GH_REPO alone on its line, which is the only export it counts", () => {
    const result = gateWith(script, "#!/usr/bin/env bash\ngh pr checks 3\n");

    assert.match(result.stderr, /export it at the top of a script, alone on its line but for a comment/);
  });

  // Named to sort after every other tracked file, so the missing one is the
  // listing loop's last, where a failing test is the loop's own status.
  it("skips a tracked file deleted from the worktree, rather than stop the gate", () => {
    gateWith("scripts/zz-gone.sh", "echo\n");
    rmSync(join(repo, "scripts/zz-gone.sh"));

    const result = gate(head(), { GATE_SKIP_REVIEW: "1" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Every gh command is told its repository/);
  });

  it("fails the gate when the files to check can't be listed, rather than pass having checked none", () => {
    writeFileSync(join(repo, ".git/index"), "not an index");

    const result = gate(head(), { GATE_SKIP_REVIEW: "1" });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Every gh command is told its repository/);
  });
});

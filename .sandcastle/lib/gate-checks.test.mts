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

  it("doesn't skip the check for any other value of GATE_SKIP_REVIEW", () => {
    const result = gate(head(), { GATE_SKIP_REVIEW: "true", REVIEW_EXIT: "1" });

    assert.notEqual(result.status, 0);
    assert.equal(calls(), `check ${head()}\n`);
  });
});

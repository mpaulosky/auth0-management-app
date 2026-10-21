import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/watch-pr.sh, run for real against a stub gh on PATH that logs the
// GH_REPO each call sees and answers that the PR merged, so the script exits
// after its first call.
const watchPr = fileURLToPath(new URL("../../scripts/watch-pr.sh", import.meta.url));

let dir: string;
let log: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "watch-pr-")));
  log = join(dir, "gh.log");
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/gh"), `#!/usr/bin/env bash\necho "$GH_REPO" >> '${log}'\necho '{"state":"MERGED"}'\n`);
  chmodSync(join(dir, "bin/gh"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The script sleeps a minute between passes and waits up to 30 minutes, so a
// change that stops it exiting on the stub's answer is killed and fails here
// in seconds rather than holding up the gate.
function watch(env: NodeJS.ProcessEnv) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["GH_REPO", "WATCH_PR_REPO"].includes(name)));
  return spawnSync("bash", [watchPr, "3"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    env: { ...clean, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, WATCH_PR_IDLE_MINUTES: "1", ...env },
  });
}

describe("scripts/watch-pr.sh's repository", () => {
  it("runs gh with GH_REPO set to this repository, whatever GH_REPO was", () => {
    const result = watch({ GH_REPO: "someone/fork" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PR #3 is MERGED/);
    assert.equal(readFileSync(log, "utf8"), "mpaulosky/auth0-management-app\n");
  });

  it("runs gh with GH_REPO set to WATCH_PR_REPO when it's given", () => {
    const result = watch({ WATCH_PR_REPO: "o/r" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, "utf8"), "o/r\n");
  });
});

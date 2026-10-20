import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UncountedStopError } from "./errors.mts";
import type { PassOutcome } from "./follow-up-pass.mts";
import { followUpOnlyRun, followUpRunSteps, type FollowUpRunSteps } from "./follow-up-run.mts";
import type { FollowUpGitHub, PassTarget, SweepResult } from "./follow-up.mts";
import type { SandcastleIssue } from "./github.mts";

const target = (number: number): PassTarget => ({
  number,
  id: `PR_${number}`,
  headRefName: `feature/${number}-add-search`,
  headRefOid: "a".repeat(40),
  issueNumber: number,
  reasons: ["it has merge conflicts"],
  conflicted: true,
});

const issues = [{ number: 42 }] as unknown as SandcastleIssue[];

// FollowUpRunSteps stubs that record the order of their calls and what the
// passes step was given.
function steps(sweep: SweepResult, passes?: (targets: readonly PassTarget[]) => Promise<PassOutcome[]>) {
  const calls: string[] = [];
  const logs: string[] = [];
  const given: { targets: readonly PassTarget[]; issues: readonly SandcastleIssue[]; base: string }[] = [];
  const stub: FollowUpRunSteps = {
    startRound: () => void calls.push("startRound"),
    sweep: () => {
      calls.push("sweep");
      return sweep;
    },
    fetchMain: () => {
      calls.push("fetchMain");
      return "origin/main";
    },
    queue: () => {
      calls.push("queue");
      return issues;
    },
    passes: async (targets, queued, base) => {
      calls.push("passes");
      given.push({ targets, issues: queued, base });
      return passes === undefined ? [] : passes(targets);
    },
    log: (line) => void logs.push(line),
  };
  return { stub, calls, logs, given };
}

// #53: with SANDCASTLE_MODE=follow-up the host runs only the sweep and the
// passes, once, then exits: no intake, no builds, no new rounds.
describe("followUpOnlyRun", () => {
  it("sweeps once, then fetches main, reads the queue and runs the passes the sweep found", async () => {
    const targets = [target(101), target(102)];
    const { stub, calls, given } = steps({ needsPass: [101, 102], passes: targets });

    await followUpOnlyRun(stub);

    assert.deepEqual(calls, ["startRound", "sweep", "fetchMain", "queue", "passes"]);
    assert.deepEqual(given, [{ targets, issues, base: "origin/main" }]);
  });

  it("runs the sweep and the passes once, not once per round", async () => {
    const { stub, calls } = steps({ needsPass: [101], passes: [target(101)] });

    await followUpOnlyRun(stub);

    assert.equal(calls.filter((call) => call === "sweep").length, 1);
    assert.equal(calls.filter((call) => call === "passes").length, 1);
  });

  it("exits with a log line, fetching nothing and running no pass, when no PR needs one", async () => {
    const { stub, calls, logs } = steps({ needsPass: [], passes: [] });

    await followUpOnlyRun(stub);

    assert.deepEqual(calls, ["startRound", "sweep"]);
    assert.ok(logs.some((line) => line.includes("No open PR needs a follow-up pass. Exiting.")), logs.join("\n"));
  });

  it("rejects with the UncountedStopError a pass stops with, so the run ends stopped", async () => {
    const { stub } = steps({ needsPass: [101], passes: [target(101)] }, async () => {
      throw new UncountedStopError("the time budget has passed");
    });

    await assert.rejects(followUpOnlyRun(stub), UncountedStopError);
  });

  it("resolves when the passes settle with skipped or failed outcomes", async () => {
    const { stub } = steps({ needsPass: [101], passes: [target(101)] }, async () => [{ kind: "push-failed", error: "rejected" }]);

    await assert.doesNotReject(followUpOnlyRun(stub));
  });
});

// A FollowUpGitHub with nothing open, one in-scope issue and the calls that
// matter to a follow-up run recorded; `overrides` replaces any member.
function githubStub(overrides: Partial<FollowUpGitHub> = {}) {
  const closedCalls: string[] = [];
  const handBacks: number[] = [];
  const github: FollowUpGitHub = {
    hostLogin: () => "sandcastle-bot",
    openPullRequests: () => [],
    closedPullRequests: (author) => {
      closedCalls.push(author);
      return [];
    },
    inScopeIssues: () => [{ number: 42, labels: [] }],
    labelTimeline: () => [],
    requestCopilotReview: () => {},
    updateBranch: () => {},
    handBack: (issueNumber) => void handBacks.push(issueNumber),
    isOwner: () => true,
    pullRequestEvents: () => [],
    addPullRequestLabel: () => {},
    ...overrides,
  };
  return { github, closedCalls, handBacks };
}

// The live wiring of the sweep step, run against a stub GitHub.
describe("followUpRunSteps", () => {
  it("sweeps without handing back closed PRs, which a full run does", async () => {
    const { github, closedCalls, handBacks } = githubStub();

    followUpRunSteps(github).sweep();

    assert.deepEqual(closedCalls, []);
    assert.deepEqual(handBacks, []);
  });

  it("lets a failed sweep reach the caller instead of logging that no PR needs a pass", async () => {
    const { github } = githubStub({
      hostLogin: () => {
        throw new Error("gh api failed: HTTP 502");
      },
    });
    const { stub, logs } = steps({ needsPass: [], passes: [] });
    const run = followUpRunSteps(github);

    await assert.rejects(followUpOnlyRun({ ...stub, sweep: run.sweep }), /HTTP 502/);

    assert.ok(!logs.some((line) => line.includes("No open PR needs")), logs.join("\n"));
  });
});

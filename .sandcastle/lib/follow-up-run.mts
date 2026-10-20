// ---------------------------------------------------------------------------
// Follow-up-only run
//
// A run started with SANDCASTLE_MODE=follow-up (#53) does the sweep and the
// follow-up passes once, then exits: no intake, no builds, no new rounds. It
// runs beside a build, in its own concurrency group, so a review or a CI
// result is answered within minutes rather than after the build. The two runs
// stay off each other's PRs through sandcastle:building: a pass claims it on
// the PR's issue, and the sweep skips a PR whose issue carries it
// (lib/follow-up.mts#sweepSkipReason).
// ---------------------------------------------------------------------------

import { fetchMain } from "./branches.mts";
import { followUpPassPhase, type PassOutcome } from "./follow-up-pass.mts";
import { followUpPhase, liveFollowUpGitHub, sweepPullRequests, type PassTarget, type SweepResult } from "./follow-up.mts";
import type { SandcastleIssue } from "./github.mts";
import { loadQueue, startQueueRound } from "./queue.mts";
import { outcomeReport, unlabelledPrReport, waitingPrReport } from "./report.mts";

// What followUpOnlyRun needs; tests pass a stub that records calls.
export type FollowUpRunSteps = {
  startRound(): void;
  sweep(): SweepResult;
  fetchMain(): string;
  queue(): readonly SandcastleIssue[];
  passes(targets: readonly PassTarget[], issues: readonly SandcastleIssue[], base: string): Promise<PassOutcome[]>;
  log(line: string): void;
};

// The live steps, the same calls main.mts makes in a full run's round. The
// sweep leaves closed PRs' hand-backs to full runs (handBackClosed false), so
// two runs can't both hand back one issue. Its set of PRs that have carried
// review:claude starts empty, since this run sweeps only once.
export const liveFollowUpRunSteps: FollowUpRunSteps = {
  startRound: () => startQueueRound(),
  sweep: () =>
    followUpPhase(() =>
      sweepPullRequests(
        liveFollowUpGitHub,
        console.log,
        Date.now(),
        outcomeReport,
        waitingPrReport,
        unlabelledPrReport,
        new Set<number>(),
        false,
      ),
    ),
  fetchMain: () => fetchMain(),
  queue: () => loadQueue(),
  passes: (targets, issues, base) => followUpPassPhase(targets, issues, base),
  log: (line) => console.log(line),
};

// The sweep, then the follow-up passes it found, once. An UncountedStopError
// from the passes propagates, so main.mts's catch ends the run "stopped", as
// it does a full run.
export async function followUpOnlyRun(steps: FollowUpRunSteps = liveFollowUpRunSteps): Promise<void> {
  steps.startRound();
  const { passes } = steps.sweep();
  if (passes.length === 0) {
    steps.log("No open PR needs a follow-up pass. Exiting.");
    return;
  }
  const base = steps.fetchMain();
  await steps.passes(passes, steps.queue(), base);
}

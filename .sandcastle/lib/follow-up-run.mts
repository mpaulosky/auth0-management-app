// ---------------------------------------------------------------------------
// Follow-up-only run
//
// A run started with SANDCASTLE_MODE=follow-up (#53) does the sweep and the
// follow-up passes once, then exits: no intake, no builds, no new rounds. It
// runs beside a build, in its own concurrency group, so a review or a CI
// result is answered within minutes rather than after the build. The two runs
// stay off each other's PRs through sandcastle:building: a pass claims it on
// the PR's issue, or on a hand-off PR itself (#58), and the sweep skips a PR
// whose claim is held (lib/follow-up.mts#sweepSkipReason).
// ---------------------------------------------------------------------------

import { fetchMain } from "./branches.mts";
import { followUpPassPhase, type PassOutcome } from "./follow-up-pass.mts";
import { liveFollowUpGitHub, sweepPullRequests, type FollowUpGitHub, type PassTarget, type SweepResult } from "./follow-up.mts";
import type { SandcastleIssue } from "./github.mts";
import { loadQueue, startQueueRound } from "./queue.mts";
import { outcomeReport, unlabelledPrReport, waitingPrReport } from "./report.mts";

// What followUpOnlyRun needs; tests pass a stub that records calls.
export type FollowUpRunSteps = {
  startRound(): void;
  sweep(): SweepResult & { failed: readonly number[] };
  fetchMain(): string;
  queue(): readonly SandcastleIssue[];
  passes(targets: readonly PassTarget[], issues: readonly SandcastleIssue[], base: string): Promise<PassOutcome[]>;
  log(line: string): void;
};

// The steps with `github` behind the sweep, the same calls main.mts makes in a
// full run's round. The sweep leaves closed PRs' hand-backs to full runs
// (handBackClosed false), so two runs can't both hand back one issue. Its set of
// PRs that have carried review:claude starts empty, since this run sweeps once.
// It doesn't go through followUpPhase: that swallows a failed sweep because the
// next round retries it, and this run has no next round, so a failure must
// reach main.mts and end the run red rather than log "no PR needs a pass". The
// sweep catches a failure on one PR itself, so the numbers of those PRs come
// back in `failed` for followUpOnlyRun to return, after the passes.
export function followUpRunSteps(github: FollowUpGitHub): FollowUpRunSteps {
  return {
    startRound: () => startQueueRound(),
    sweep: () => {
      const failed: number[] = [];
      const result = sweepPullRequests(
        github,
        console.log,
        Date.now(),
        outcomeReport,
        waitingPrReport,
        unlabelledPrReport,
        new Set<number>(),
        false,
        (pr) => void failed.push(pr),
      );
      return { ...result, failed };
    },
    fetchMain: () => fetchMain(),
    queue: () => loadQueue(),
    passes: (targets, issues, base) => followUpPassPhase(targets, issues, base),
    log: (line) => console.log(line),
  };
}

// The live steps.
export const liveFollowUpRunSteps: FollowUpRunSteps = followUpRunSteps(liveFollowUpGitHub);

// The sweep, then the follow-up passes it found, once. An UncountedStopError
// from the passes propagates, so main.mts's catch ends the run "stopped", as
// it does a full run. Returns the PRs the sweep couldn't follow up: this run
// has no next round to sweep them again, so main.mts records them in the run
// report and ends the run red, rather than a throw that reads as a crash.
export async function followUpOnlyRun(steps: FollowUpRunSteps = liveFollowUpRunSteps): Promise<readonly number[]> {
  steps.startRound();
  const { passes, failed } = steps.sweep();
  if (passes.length === 0) {
    steps.log("No open PR needs a follow-up pass. Exiting.");
  } else {
    const base = steps.fetchMain();
    await steps.passes(passes, steps.queue(), base);
  }
  return failed;
}

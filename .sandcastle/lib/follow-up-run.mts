// ---------------------------------------------------------------------------
// Follow-up-only run
//
// A run started with SANDCASTLE_MODE=follow-up (#53) does the sweep and the
// follow-up passes once, then exits: no intake, no builds, no new rounds. It
// runs beside a build, in its own concurrency group, so a review or a CI
// result is answered within minutes rather than after the build.
// ---------------------------------------------------------------------------

import type { SandcastleIssue } from "./github.mts";
import type { PassOutcome } from "./follow-up-pass.mts";
import type { PassTarget, SweepResult } from "./follow-up.mts";

// What followUpOnlyRun needs; tests pass a stub that records calls.
export type FollowUpRunSteps = {
  startRound(): void;
  sweep(): SweepResult;
  fetchMain(): string;
  queue(): readonly SandcastleIssue[];
  passes(targets: readonly PassTarget[], issues: readonly SandcastleIssue[], base: string): Promise<PassOutcome[]>;
  log(line: string): void;
};

const notImplemented = (): never => {
  throw new Error("Not implemented");
};

export const liveFollowUpRunSteps: FollowUpRunSteps = {
  startRound: notImplemented,
  sweep: notImplemented,
  fetchMain: notImplemented,
  queue: notImplemented,
  passes: notImplemented,
  log: notImplemented,
};

// The sweep, then the follow-up passes it found, once.
export async function followUpOnlyRun(_steps: FollowUpRunSteps = liveFollowUpRunSteps): Promise<void> {
  throw new Error("Not implemented");
}

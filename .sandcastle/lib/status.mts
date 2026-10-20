// ---------------------------------------------------------------------------
// Sandcastle status (#65)
//
// Nothing showed why Sandcastle was holding one of its PRs. This module reads
// every open Sandcastle PR through the sweep's own functions (sweepSkipReason,
// admitToSweep, decide, markerCommentsSince), so the status can't disagree with
// what the sweep does, and renders the reason each PR is held, with the
// Sandcastle workflow's runs in progress and queued. It is read-only: nothing
// here writes to GitHub.
// ---------------------------------------------------------------------------

import type { CheckState, FollowUpGitHub, SweepAdmission, SweepDecision, SweepPullRequest } from "./follow-up.mts";
import type { CommentReads, WorkflowRun } from "./github.mts";
import type { IsOwner, QueueGitHub } from "./queue.mts";

// What the status reads; every member is a read. Tests pass a stub that also carries FollowUpGitHub's writes, which throw.
export type StatusGitHub = Pick<
  FollowUpGitHub,
  "hostLogin" | "openPullRequests" | "inScopeIssues" | "isOwner" | "pullRequestEvents" | "pullRequestBodyEdits" | "followsHandOffs"
> & {
  passComments(pr: number): CommentReads;
  workflowRuns(): WorkflowRun[];
};

// Unresolved review threads, by who opened them.
export type ThreadCounts = { bot: number; owner: number; others: number; unknown: number; answered: number };
export type CheckSummary = { total: number; running: number; red: string[] };

export type HeldReason =
  | { kind: "skipped"; reason: string }
  | { kind: "restore"; label: string; reason: string }
  | { kind: "decided"; decision: SweepDecision; handsBack: boolean };

export type PullRequestStatus =
  | {
      number: number;
      title: string;
      url: string;
      issueNumber: number | undefined;
      handOff: boolean;
      passesUsed: number;
      held: HeldReason;
      threads: ThreadCounts;
      mergeStateStatus: string;
      checks: CheckSummary;
      needsHuman: boolean;
      reviewLabel: boolean;
    }
  | { number: number; title: string; url: string; error: string };

export type StatusReport = {
  pullRequests: PullRequestStatus[];
  othersOpen: number;
  runs: { running: WorkflowRun[]; queued: WorkflowRun[] } | { error: string };
};

// How many follow-up passes the PR has used: the host's FOLLOW_UP_MARKER comments since needs-human was last removed.
export function followUpPassesUsed(_reads: CommentReads, _hostLogin: string): number {
  throw new Error("Not implemented");
}

// The PR's unresolved threads, split by who opened them.
export function threadCounts(_pr: SweepPullRequest, _isOwner: IsOwner, _hostLogin: string): ThreadCounts {
  throw new Error("Not implemented");
}

// The head's checks, counted.
export function checkSummary(_checks: readonly CheckState[]): CheckSummary {
  throw new Error("Not implemented");
}

// Why the PR is held, from the sweep's own admission and `decide`.
export function heldReason(
  _admission: SweepAdmission,
  _pr: SweepPullRequest,
  _now: number,
  _isOwner: IsOwner,
  _host: string,
  _passesUsed: number,
): HeldReason {
  throw new Error("Not implemented");
}

// Reads every Sandcastle PR's status and the workflow's runs.
export function buildStatus(_github: StatusGitHub, _now: number): StatusReport {
  throw new Error("Not implemented");
}

// The report as text.
export function renderStatus(_report: StatusReport): string {
  throw new Error("Not implemented");
}

// Prints the status; returns the exit code.
export function statusCommand(_github?: StatusGitHub, _now?: number, _out?: (text: string) => void): number {
  throw new Error("Not implemented");
}

// A QueueGitHub whose label writes do nothing, so loadQueue's fixes never reach GitHub.
export function withoutLabelWrites(_github: QueueGitHub): QueueGitHub {
  throw new Error("Not implemented");
}

export const liveStatusGitHub: StatusGitHub = {
  hostLogin: () => {
    throw new Error("Not implemented");
  },
  openPullRequests: () => {
    throw new Error("Not implemented");
  },
  inScopeIssues: () => {
    throw new Error("Not implemented");
  },
  isOwner: () => {
    throw new Error("Not implemented");
  },
  pullRequestEvents: () => {
    throw new Error("Not implemented");
  },
  pullRequestBodyEdits: () => {
    throw new Error("Not implemented");
  },
  followsHandOffs: () => {
    throw new Error("Not implemented");
  },
  passComments: () => {
    throw new Error("Not implemented");
  },
  workflowRuns: () => {
    throw new Error("Not implemented");
  },
};

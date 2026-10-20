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

import { FOLLOW_UP_LABEL, FOLLOW_UP_MARKER, FOLLOW_UP_PASS_CAP, PR_MARKER, REVIEW_LABEL, type QueueScope } from "./config.mts";
import {
  admitToSweep,
  answeredByHost,
  decide,
  isSandcastlePullRequest,
  issueNumberOf,
  lastJudgingComment,
  liveFollowUpGitHub,
  NEEDS_HUMAN,
  sweepContext,
  sweepSubject,
  type CheckState,
  type FollowUpGitHub,
  type SweepAdmission,
  type SweepContext,
  type SweepDecision,
  type SweepPullRequest,
} from "./follow-up.mts";
import { hasLabel, markerCommentReads, markerCommentsSince, sandcastleWorkflowRuns, type CommentReads, type WorkflowRun } from "./github.mts";
import { activeQueueScope, liveQueueGitHub, loadQueue, type IsOwner, type QueueGitHub } from "./queue.mts";

// What the status reads; every member is a read. The sweep's reads come from
// FollowUpGitHub, so the status reads what the sweep does; passComments is
// what the pass counts its passes from, and workflowRuns the Sandcastle
// workflow's unfinished runs. Tests pass a stub that also carries
// FollowUpGitHub's writes, which throw.
export type StatusGitHub = Pick<
  FollowUpGitHub,
  "hostLogin" | "openPullRequests" | "inScopeIssues" | "isOwner" | "pullRequestEvents" | "pullRequestBodyEdits" | "followsHandOffs"
> & {
  passComments(pr: number): CommentReads;
  workflowRuns(): WorkflowRun[];
  // The lines loadQueue gave for the issues it left out because an owner check
  // couldn't answer, as of the last inScopeIssues read. Such an issue looks
  // like an ordinary skip to the sweep's checks, so the status says so itself.
  uncheckedIssues(): string[];
};

// A PR's unresolved review threads, by who opened them: a bot, the repository
// owner, someone else, or someone whose owner check couldn't answer.
// `answered` counts the bot and owner threads the host already replied to
// (answeredByHost), which `decide` doesn't count as needing a pass.
// `replyUnknown` counts the answered threads where someone replied after the
// host and an owner check on them couldn't answer: they might be the owner's
// "still wrong", so the thread may not be answered after all.
export type ThreadCounts = { bot: number; owner: number; others: number; unknown: number; answered: number; replyUnknown: number };

// A PR head's checks: how many, how many are still running, and the names of
// the completed red ones.
export type CheckSummary = { total: number; running: number; red: string[] };

// Why a PR is held: the sweep skips it (sweepSkipReason or an admission
// check), puts back a hand-back label a stranger removed, or decides about it
// with `decide`. `handsBack` says the next pass hands the PR back, because it
// needs a pass and has used FOLLOW_UP_PASS_CAP of them. `unknown` on a skip
// says an owner check couldn't answer, which makes the status partial, as it
// ends a follow-up run red.
export type HeldReason =
  | { kind: "skipped"; reason: string; unknown: boolean }
  | { kind: "restore"; label: string; reason: string }
  | { kind: "decided"; decision: SweepDecision; handsBack: boolean };

// One open Sandcastle PR's entry in the status, or the error that stopped one
// of its reads: one PR's failure doesn't hide the others.
export type PullRequestStatus =
  | {
      number: number;
      title: string;
      url: string;
      // The issue the PR's branch names (issueNumberOf), if any.
      issueNumber: number | undefined;
      // Handed to Sandcastle with sandcastle:follow-up rather than opened by it (#58).
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

// Everything the status command prints: the Sandcastle PRs by number, how
// many other open PRs into main there are, and the workflow's unfinished
// runs, or why they couldn't be read.
export type StatusReport = {
  // The login every PR was judged against: whoever is signed in to gh here.
  // The Actions sweep judges against its own login, so the two can differ.
  host: string;
  pullRequests: PullRequestStatus[];
  othersOpen: number;
  // Open PRs that carry PR_MARKER but weren't opened by `host`, so they aren't
  // listed. If gh here isn't signed in as the account the Actions sweep
  // publishes with, these are its PRs; the status is partial when any.
  foreignMarked: { number: number; author: string | null }[];
  // Issues left out of the in-scope set for want of an owner check, so a PR on
  // one may be listed as an ordinary skip; the status is partial when any.
  uncheckedIssues: string[];
  runs: { running: WorkflowRun[]; queued: WorkflowRun[] } | { error: string };
};

// How many follow-up passes the PR has used: the host's FOLLOW_UP_MARKER
// comments since sandcastle:needs-human was last removed, counted by
// markerCommentsSince as the pass counts them (livePassHost.passCount), so a
// PR handed back and picked up again shows its new count, not its total.
export function followUpPassesUsed(reads: CommentReads, hostLogin: string): number {
  return markerCommentsSince(reads.comments, reads.timeline, NEEDS_HUMAN, FOLLOW_UP_MARKER, reads.createdAt, hostLogin).length;
}

// The PR's unresolved threads, split by who opened them, the way `decide`
// and the run report tell them apart: a bot's, the owner's (isOwner true),
// someone else's (false) and unchecked (undefined).
export function threadCounts(pr: SweepPullRequest, isOwner: IsOwner, hostLogin: string): ThreadCounts {
  const counts: ThreadCounts = { bot: 0, owner: 0, others: 0, unknown: 0, answered: 0, replyUnknown: 0 };
  for (const thread of pr.threads.filter((candidate) => !candidate.resolved)) {
    const owner = thread.byBot ? undefined : isOwner(thread.author);
    if (thread.byBot) counts.bot++;
    else if (owner === true) counts.owner++;
    else if (owner === false) counts.others++;
    else counts.unknown++;
    // Only the threads `decide` would count can be waiting on the host's answer.
    if ((thread.byBot || owner === true) && answeredByHost(thread, isOwner, hostLogin)) {
      counts.answered++;
      if (repliedAfterHostUnchecked(thread, isOwner, hostLogin)) counts.replyUnknown++;
    }
  }
  return counts;
}

// Whether a human commented on the thread after the host's answer and the
// owner check on them couldn't answer. lastJudgingComment skips such a comment
// as a stranger's, so the thread would read as answered when it may not be.
function repliedAfterHostUnchecked(thread: SweepPullRequest["threads"][number], isOwner: IsOwner, hostLogin: string): boolean {
  const comments = thread.recentComments ?? [];
  const last = lastJudgingComment(thread, isOwner, hostLogin);
  return comments
    .slice(last === undefined ? 0 : comments.lastIndexOf(last) + 1)
    .some((comment) => !comment.byBot && comment.author !== hostLogin && isOwner(comment.author) === undefined);
}

// The head's checks, counted for the PR's entry.
export function checkSummary(checks: readonly CheckState[]): CheckSummary {
  return {
    total: checks.length,
    running: checks.filter((check) => !check.completed).length,
    red: checks.filter((check) => check.completed && !check.green).map((check) => check.name),
  };
}

// Why the PR is held, from the sweep's own admission and, for a PR it
// sweeps, `decide`. A PR that needs a pass with its passes used up is handed
// back by the next pass (lib/follow-up-pass.mts); that pass reads fresh
// threads and checks first, so this is a forecast, not a promise.
export function heldReason(
  admission: SweepAdmission,
  pr: SweepPullRequest,
  now: number,
  isOwner: IsOwner,
  host: string,
  passesUsed: number,
): HeldReason {
  switch (admission.kind) {
    case "skipped":
      return { kind: "skipped", reason: admission.reason, unknown: admission.unknown };
    case "restore":
      return { kind: "restore", label: admission.label, reason: admission.reason };
    case "swept": {
      const decision = decide(pr, now, isOwner, host);
      return { kind: "decided", decision, handsBack: decision.action === "needs-pass" && passesUsed >= FOLLOW_UP_PASS_CAP };
    }
  }
}

// Reads every open Sandcastle PR's status and the workflow's runs. The
// Sandcastle PRs are the host's own and the ones labelled sandcastle:follow-up,
// each listed even when the sweep skips it, with the reason. A failure of the
// sweep's context or of the open PRs throws; one PR's failure becomes its
// entry's error, and the runs' becomes the report's.
export function buildStatus(github: StatusGitHub, now: number): StatusReport {
  const context = sweepContext(github);
  const uncheckedIssues = github.uncheckedIssues();
  const open = github.openPullRequests();
  const listed = open
    .filter((pr) => isSandcastlePullRequest(pr, context.host) || hasLabel(pr, FOLLOW_UP_LABEL))
    .sort((a, b) => a.number - b.number);
  return {
    host: context.host,
    pullRequests: listed.map((pr) => pullRequestStatus(pr, context, github, now)),
    othersOpen: open.length - listed.length,
    foreignMarked: open
      .filter((pr) => !listed.includes(pr) && pr.body.includes(PR_MARKER) && pr.author !== context.host)
      .map((pr) => ({ number: pr.number, author: pr.author })),
    uncheckedIssues,
    runs: workflowRunsStatus(github),
  };
}

// One listed PR's entry, or its error entry when one of its reads throws.
function pullRequestStatus(pr: SweepPullRequest, context: SweepContext, github: StatusGitHub, now: number): PullRequestStatus {
  const { host, inScope, handOffs } = context;
  try {
    const admission = admitToSweep(pr, context, github);
    const passesUsed = followUpPassesUsed(github.passComments(pr.number), host);
    const subject = sweepSubject(pr, inScope, host, handOffs);
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      issueNumber: issueNumberOf(pr.headRefName),
      handOff: subject === undefined ? hasLabel(pr, FOLLOW_UP_LABEL) : subject.kind === "pull-request",
      passesUsed,
      held: heldReason(admission, pr, now, github.isOwner, host, passesUsed),
      threads: threadCounts(pr, github.isOwner, host),
      mergeStateStatus: pr.mergeStateStatus,
      checks: checkSummary(pr.checks),
      needsHuman: hasLabel(pr, NEEDS_HUMAN),
      reviewLabel: hasLabel(pr, REVIEW_LABEL),
    };
  } catch (error) {
    return { number: pr.number, title: pr.title, url: pr.url, error: messageOf(error) };
  }
}

// The workflow's unfinished runs, split into the one in progress and the
// queued ones, or why they couldn't be read.
function workflowRunsStatus(github: StatusGitHub): StatusReport["runs"] {
  try {
    const runs = github.workflowRuns();
    return {
      running: runs.filter((run) => run.status === "in_progress"),
      queued: runs.filter((run) => run.status !== "in_progress"),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The report as text: the workflow's runs first, then one block per PR, then
// the count of other open PRs.
export function renderStatus(report: StatusReport): string {
  const lines = [`Judged against the host login ${report.host}, the account signed in to gh here.`, "", "Sandcastle workflow"];
  if ("error" in report.runs) {
    lines.push(`  Couldn't read the Sandcastle workflow's runs: ${report.runs.error}`);
  } else {
    const { running, queued } = report.runs;
    if (running.length === 0) lines.push("  No Sandcastle run is in progress.");
    for (const run of running) lines.push(`  Running: ${runLine(run)}`);
    if (queued.length === 0) lines.push("  No Sandcastle run is queued.");
    for (const run of queued) lines.push(`  Queued: ${runLine(run)}`);
  }
  if (report.pullRequests.length === 0) lines.push("", "No open Sandcastle PR into main.");
  for (const status of report.pullRequests) lines.push("", ...pullRequestLines(status));
  if (report.uncheckedIssues.length > 0) {
    lines.push("", "Issues whose owner check couldn't answer, so this status is partial:", ...report.uncheckedIssues.map((line) => `  ${line.trim()}`));
  }
  if (report.foreignMarked.length > 0) {
    lines.push(
      "",
      `Open PRs that carry the Sandcastle PR marker but weren't opened by ${report.host}, so they aren't listed above.`,
      "If the Actions sweep publishes as another login, run this signed in as that account; this status is partial:",
      ...report.foreignMarked.map((foreign) => `  PR #${foreign.number}, opened by ${foreign.author ?? "a deleted account"}`),
    );
  }
  lines.push("", `${report.othersOpen} other open PRs into main aren't Sandcastle's.`);
  return lines.join("\n");
}

// A run's line: its id, the event and title that started it, its branch when
// that isn't main, when it was created and its page.
function runLine(run: WorkflowRun): string {
  const branch = run.headBranch === null || run.headBranch === "main" ? "" : `, on ${run.headBranch}`;
  return `run ${run.id} (${run.event}: ${JSON.stringify(run.displayTitle)}${branch}), since ${run.createdAt}  ${run.url}`;
}

function pullRequestLines(status: PullRequestStatus): string[] {
  if ("error" in status) return [`PR #${status.number} ${status.title}: couldn't read its status: ${status.error}`];
  const issue = status.issueNumber === undefined ? "" : ` (issue #${status.issueNumber})`;
  const { threads, held } = status;
  const threadParts = [`${threads.bot} bot`, `${threads.owner} owner`, `${threads.others} waiting on someone else`];
  if (threads.unknown > 0) threadParts.push(`${threads.unknown} whose author couldn't be checked`);
  if (threads.replyUnknown > 0) threadParts.push(`${threads.replyUnknown} with a reply whose author couldn't be checked`);
  if (threads.answered > 0) threadParts.push(`${threads.answered} answered by Sandcastle and waiting on the owner`);
  // A BEHIND PR the sweep doesn't update is left behind on purpose (#59 on 2026-10-20 looked stuck).
  const behind = status.mergeStateStatus === "BEHIND" && !(held.kind === "decided" && held.decision.action === "update-branch");
  const mergeState = `${status.mergeStateStatus}${behind ? " (left behind main until nothing else holds it)" : ""}`;
  return [
    `PR #${status.number} ${status.title}${issue}${status.handOff ? " (handed off with sandcastle:follow-up)" : ""}`,
    `  ${status.url}`,
    `  Follow-up passes: ${status.passesUsed} of ${FOLLOW_UP_PASS_CAP}`,
    `  Held: ${heldText(held)}`,
    `  Threads: ${threadParts.join(", ")}`,
    `  Merge state: ${mergeState} · Checks: ${checksText(status.checks)} · ${NEEDS_HUMAN}: ${yesNo(status.needsHuman)} · ${REVIEW_LABEL}: ${yesNo(status.reviewLabel)}`,
  ];
}

function heldText(held: HeldReason): string {
  switch (held.kind) {
    case "skipped":
      return `the sweep skips it: ${held.reason}${held.unknown ? " (an owner check couldn't answer, so this status is partial)" : ""}`;
    case "restore":
      return `the next sweep puts ${held.label} back (${held.reason}), and leaves the PR alone this round`;
    case "decided":
      switch (held.decision.action) {
        case "needs-pass": {
          const handsBack = held.handsBack
            ? `; its ${FOLLOW_UP_PASS_CAP} follow-up passes are used up, so the next pass hands it back with ${NEEDS_HUMAN}`
            : "";
          return `needs a follow-up pass: ${held.decision.reasons.join("; ")}${handsBack}`;
        }
        case "wait":
          return `waits: ${held.decision.reason}`;
        case "request-review":
          return "the next sweep asks Copilot again to review its head";
        case "update-branch":
          return "only behind main: the next sweep updates its branch";
        case "leave":
          return `left alone: ${held.decision.reason}`;
      }
  }
}

function checksText(checks: CheckSummary): string {
  if (checks.total === 0) return "none reported";
  const parts: string[] = [];
  if (checks.running > 0) parts.push(`${checks.running} of ${checks.total} running`);
  if (checks.red.length > 0) parts.push(`red: ${checks.red.join(", ")}`);
  return parts.length === 0 ? `all ${checks.total} green` : parts.join(", ");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

// Whether an owner check failed for the PR: its admission was skipped for
// want of an answer, an unresolved thread's author couldn't be checked, or an
// answered thread has a later reply whose author couldn't be. The sweep ends a
// follow-up run red for the first, and `decide` doesn't count the others, so
// the entry is incomplete.
function ownerCheckFailed(status: PullRequestStatus): boolean {
  return "held" in status && ((status.held.kind === "skipped" && status.held.unknown) || status.threads.unknown > 0 || status.threads.replyUnknown > 0);
}

// Prints the status and returns the exit code: 1 when the status, a PR's
// entry or the runs couldn't be read, or an owner check couldn't answer, so a
// script can tell a partial status from a whole one; 0 otherwise.
export function statusCommand(
  github: StatusGitHub = liveStatusGitHub,
  now: number = Date.now(),
  out: (text: string) => void = console.log,
): number {
  let report: StatusReport;
  try {
    report = buildStatus(github, now);
  } catch (error) {
    out(`Couldn't read Sandcastle's status: ${messageOf(error)}`);
    return 1;
  }
  out(renderStatus(report));
  const partial = report.pullRequests.some((status) => "error" in status || ownerCheckFailed(status)) || "error" in report.runs || report.uncheckedIssues.length > 0 || report.foreignMarked.length > 0;
  return partial ? 1 : 0;
}

// A QueueGitHub whose label writes do nothing, so loadQueue's fixes (removing
// an untrusted sandcastle:ready, restoring a hand-back label a stranger
// removed) never reach GitHub, while it still returns the labels the sweep
// would see after them.
export function withoutLabelWrites(github: QueueGitHub): QueueGitHub {
  return { ...github, removeLabel: () => {}, addLabel: () => {} };
}

// The issues the sweep would see in scope, read through loadQueue with its
// label writes removed, plus its skip lines for the issues it couldn't check
// (see uncheckedIssues). Its other lines are dropped: the `↺` ones would claim
// writes that never happened. A fresh `logged` set keeps loadQueue's
// once-per-run dedupe from hiding a line.
export function readInScopeIssues(
  github: QueueGitHub,
  scope: QueueScope = activeQueueScope(),
): { issues: { number: number; labels: string[] }[]; unchecked: string[] } {
  const unchecked: string[] = [];
  const kept = loadQueue(scope, withoutLabelWrites(github), (line) => {
    if (line.includes("couldn't check")) unchecked.push(line);
  }, new Set());
  return { issues: kept.map(({ number, labels }) => ({ number, labels })), unchecked };
}

// The live StatusGitHub: the sweep's own reads, except the in-scope issues
// (see readInScopeIssues). inScopeIssues keeps the lines it couldn't check
// for uncheckedIssues, which buildStatus reads right after it.
let unchecked: string[] = [];
export const liveStatusGitHub: StatusGitHub = {
  hostLogin: () => liveFollowUpGitHub.hostLogin(),
  openPullRequests: () => liveFollowUpGitHub.openPullRequests(),
  inScopeIssues: () => {
    const read = readInScopeIssues(liveQueueGitHub());
    unchecked = read.unchecked;
    return read.issues;
  },
  uncheckedIssues: () => unchecked,
  isOwner: (login) => liveFollowUpGitHub.isOwner(login),
  pullRequestEvents: (number) => liveFollowUpGitHub.pullRequestEvents(number),
  pullRequestBodyEdits: (number) => liveFollowUpGitHub.pullRequestBodyEdits(number),
  followsHandOffs: () => liveFollowUpGitHub.followsHandOffs(),
  passComments: (number) => markerCommentReads(number),
  workflowRuns: () => sandcastleWorkflowRuns(),
};

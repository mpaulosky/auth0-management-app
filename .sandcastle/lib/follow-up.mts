// ---------------------------------------------------------------------------
// Follow-up sweep
//
// Nothing acted on a Sandcastle PR once it was open: it could fall behind
// main, miss its Copilot review, or close without merging while its issue
// stayed open. Each round, before intake, the host sweeps every open,
// non-draft, same-repo PR into main from a matching issue branch that it
// itself published (see isSandcastlePullRequest), and acts on the ones that
// need no agent: re-requesting a stale Copilot review, updating a branch
// that's only behind main, and handing an issue back when its latest PR
// closed without merging (a full run only). It leaves alone a PR whose issue
// is labelled sandcastle:building, which another run, or this one, holds
// while it builds or passes on it (#53). A PR that needs more than that
// (DIRTY, a red check, an unresolved bot or owner thread) is logged here and
// returned as a PassTarget: the agent pass that fixes it lives in
// lib/follow-up-pass.mts (#78). A hand-opened PR the owner labelled
// sandcastle:follow-up is swept the same way (#58), with the PR itself, not
// an issue, as what its claim and brief are about (see sweepSubject).
// ---------------------------------------------------------------------------

import { discardClosedWork, isHandOffBranch, isIssueBranch, type BranchRefs } from "./branches.mts";
import {
  BUILDING_LABEL,
  COPILOT_REREQUEST_AFTER_MS,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_REPLY_MARKER,
  PR_MARKER,
  QUEUE_LABEL,
  REVIEW_LABEL,
  SESSION_REPLY_MARKER,
  type QueueScope,
} from "./config.mts";
import {
  addPullRequestLabel,
  bodyEdits,
  closedPullRequests,
  handBack,
  hasCarriedReviewLabel,
  hasLabel,
  HeadMovedError,
  isCopilot,
  issueEvents,
  issueLabels,
  labelsOn,
  labelTimeline,
  openPullRequestsForSweep,
  pushAccess,
  requestCopilotReview,
  signedInHostLogin,
  timestamp,
  updatePullRequestBranch,
  type ClosedPullRequest,
  type ContentEdit,
  type IssueEvent,
  type PullRequestIdentity,
  type TimelineLabelEvent,
} from "./github.mts";
import { activeQueueScope, approval, labelOriginFixes, loadQueue, ownerCheck, type IsOwner } from "./queue.mts";
import {
  outcomeReport,
  unlabelledPrReport,
  waitingPrReport,
  type OutcomeReport,
  type UnlabelledPrReport,
  type WaitingPrEntry,
  type WaitingPrReport,
} from "./report.mts";

// One check run or status on a PR's head commit, normalised from either
// GraphQL shape (CheckRun or StatusContext) by lib/github.mts#openPullRequestsForSweep.
export type CheckState = { name: string; completed: boolean; green: boolean; completedAt: string | null };

// An open PR with everything the sweep decides from, normalised from one
// paginated GraphQL query (lib/github.mts#openPullRequestsForSweep).
export type SweepPullRequest = PullRequestIdentity & {
  id: string;
  headRefOid: string;
  isDraft: boolean;
  labels: string[];
  mergeStateStatus: string;
  // The logins GitHub still has pending a review request from.
  reviewRequests: string[];
  reviews: { author: string | null; commitOid: string | null }[];
  // byBot: whether the thread's first comment's author is a Bot. author: that
  // comment's login, for isOwner (null for a deleted account or no comment).
  // recentComments: the thread's newest comments, oldest first, so `decide` can
  // tell a thread the host already answered from one still waiting on a pass.
  threads: {
    resolved: boolean;
    byBot: boolean;
    author: string | null;
    recentComments?: { author: string | null; byBot: boolean; body: string }[];
    // Set when the thread has comments older than recentComments holds.
    recentTruncated?: true;
  }[];
  checks: CheckState[];
  // review_requested timeline events naming Copilot, oldest first.
  copilotRequestedAt: string[];
  // Set when any nested list (reviews, threads, checks, ...) was truncated by
  // GraphQL's page size, so the sweep can't decide safely from partial data.
  truncated: boolean;
  // The PR's page, for the run report.
  url: string;
  // The PR's title, for the status command (#65).
  title: string;
};

// Whether a login is Copilot's code-review account (see
// lib/github.mts#isCopilot, which openPullRequestsForSweep also reads with).
export { isCopilot };

// The label a hand-back puts on a PR, which the sweep leaves alone (and the status command names).
export const NEEDS_HUMAN = "sandcastle:needs-human";

// The PR-level counterpart of lib/queue.mts#ISSUE_LABEL_RULES: a PR's
// needs-human removal counts as a re-queue only when the repository owner
// made it (#146). Nothing on a PR is trusted as an add.
const PR_LABEL_RULES = { trustAdds: [], trustRemovals: [NEEDS_HUMAN] } as const;

// The issue number a PR's head branch names, read from
// feature/{n}-..., fix/{n}-... or hotfix/{n}-..., but only when it's a branch
// name isIssueBranch (lib/branches.mts) actually accepts: a branch name
// reaches a shell elsewhere in the pipeline.
export function issueNumberOf(headRefName: string): number | undefined {
  const match = /^(?:feature|fix|hotfix)\/(\d+)-/.exec(headRefName);
  if (!match) return undefined;
  const number = Number(match[1]);
  return isIssueBranch(headRefName, number) ? number : undefined;
}

// Whether the host published `pr` itself: not a fork, into main, authored by
// the repository owner's own login (the account the host publishes with,
// never an organization's, see #214), carrying PR_MARKER, and on an issue
// branch. A collaborator's PR on a matching branch, or one of the host's own
// from before this marker existed, is never this.
export function isSandcastlePullRequest(pr: PullRequestIdentity, host: string): boolean {
  return (
    pr.isCrossRepository === false &&
    pr.baseRefName === "main" &&
    pr.author === host &&
    pr.body.includes(PR_MARKER) &&
    issueNumberOf(pr.headRefName) !== undefined
  );
}

// Whether `comment` is the host's own reply on a review thread: by `hostLogin`
// and either opening with FOLLOW_UP_REPLY_MARKER or carrying
// SESSION_REPLY_MARKER (the owner's session posts with the host's token). One
// by anyone else never is, so a stranger can't hide a thread by quoting a marker.
export function isHostReply(comment: { author: string | null; body: string } | null | undefined, hostLogin: string): boolean {
  return (
    comment !== null &&
    comment !== undefined &&
    comment.author === hostLogin &&
    (comment.body.startsWith(FOLLOW_UP_REPLY_MARKER) || comment.body.includes(SESSION_REPLY_MARKER))
  );
}

// Whether the host already answered `thread`, the way threadsForRole
// (lib/follow-up-pass.mts) judges it: the newest comment by the host, the
// repository owner or, on a bot thread, a bot is the host's own reply. A
// stranger's comment after it doesn't count, so it can't put an answered thread
// back on the PR's to-do list.
export function answeredByHost(thread: SweepPullRequest["threads"][number], isOwner: IsOwner, hostLogin: string | undefined): boolean {
  if (hostLogin === undefined) {
    return false;
  }
  return isHostReply(lastJudgingComment(thread, isOwner, hostLogin), hostLogin);
}

// The newest comment `answeredByHost` judges a thread by (see there), or
// undefined when recentComments holds none.
export function lastJudgingComment(thread: SweepPullRequest["threads"][number], isOwner: IsOwner, hostLogin: string | undefined) {
  return thread.recentComments?.findLast(
    (comment) => (thread.byBot && comment.byBot) || comment.author === hostLogin || isOwner(comment.author) === true,
  );
}

// Whether `thread` can't be judged from recentComments: it has older comments
// and the newest ones hold none by a bot, the host or the owner, so strangers'
// replies may have pushed the host's answer out of the window. threadsForRole
// reads the whole thread, so counting it here would send the PR to a pass that
// drops the thread, every round.
function unjudgeable(thread: SweepPullRequest["threads"][number], isOwner: IsOwner, hostLogin: string | undefined): boolean {
  return thread.recentTruncated === true && lastJudgingComment(thread, isOwner, hostLogin) === undefined;
}

// How the sweep treats a PR it doesn't skip: a Sandcastle PR of an in-scope
// issue, whose claim and brief are the issue, or a hand-off PR (#58), whose
// claim and brief are the PR itself.
export type SweepSubject = { kind: "issue"; issueNumber: number } | { kind: "pull-request" };

// "issue" when isSandcastlePullRequest(pr, host) and its issue is in
// `inScope`; otherwise "pull-request" when `handOffs`, the PR carries
// FOLLOW_UP_LABEL and its branch is one isHandOffBranch accepts; otherwise
// undefined. A Sandcastle PR keeps its issue even when it carries the label;
// one whose issue is out of scope becomes a hand-off, since the owner never
// approved that issue's text for a prompt.
export function sweepSubject(
  pr: PullRequestIdentity & { labels: string[] },
  inScope: ReadonlySet<number>,
  host: string,
  handOffs: boolean,
): SweepSubject | undefined {
  const issueNumber = issueNumberOf(pr.headRefName);
  if (isSandcastlePullRequest(pr, host) && issueNumber !== undefined && inScope.has(issueNumber)) {
    return { kind: "issue", issueNumber };
  }
  if (handOffs && hasLabel(pr, FOLLOW_UP_LABEL) && isHandOffBranch(pr.headRefName)) return { kind: "pull-request" };
  return undefined;
}

// Whether a run in `scope` follows hand-off PRs: only the default Sandcastle
// label scope, so a local run on one issue or another label never touches them.
export function followsHandOffs(scope: QueueScope): boolean {
  return scope.kind === "label" && scope.label.toLowerCase() === QUEUE_LABEL.toLowerCase();
}

// The first reason the sweep skips `pr`, checked in this order: a fork, not
// into main, not an issue branch, the issue isn't open and in scope, the
// issue is in `building` (labelled sandcastle:building), a draft, labelled
// sandcastle:needs-human, not the host's, no PR_MARKER, or truncated.
// Undefined when none applies, so the sweep decides from it. The building
// skip keeps a full run and a follow-up run, which can go at the same time
// (#53), off a PR the other is passing on or a build is opening: neither
// updates its branch, re-asks Copilot or relabels it. With `handOffs`, a
// hand-off PR (sweepSubject, #58) skips the issue, author and marker checks,
// and is held back by its own sandcastle:building instead of an issue's,
// since a pass on it claims the PR itself.
export function sweepSkipReason(
  pr: SweepPullRequest,
  inScope: ReadonlySet<number>,
  host: string,
  building: ReadonlySet<number> = new Set(),
  handOffs: boolean = false,
): string | undefined {
  if (pr.isCrossRepository !== false) return "it's from a fork";
  if (pr.baseRefName !== "main") return `it's into ${pr.baseRefName}, not main`;
  if (sweepSubject(pr, inScope, host, handOffs)?.kind === "pull-request") {
    if (hasLabel(pr, BUILDING_LABEL)) return `it's labelled ${BUILDING_LABEL}, so another run is passing on it`;
    // A build of the branch's issue shares this branch and its worktree, and
    // its claim is on the issue, not on this PR.
    const branchIssue = issueNumberOf(pr.headRefName);
    if (branchIssue !== undefined && building.has(branchIssue)) {
      return `#${branchIssue} is labelled ${BUILDING_LABEL}, so another run is building on this branch`;
    }
    if (pr.isDraft) return "it's a draft";
    if (hasLabel(pr, NEEDS_HUMAN)) return `it's labelled ${NEEDS_HUMAN}`;
    if (pr.truncated) return "it has more reviews, threads or checks than one read holds";
    return undefined;
  }
  const issueNumber = issueNumberOf(pr.headRefName);
  if (issueNumber === undefined) return `${pr.headRefName} isn't an issue branch`;
  if (!inScope.has(issueNumber)) return `#${issueNumber} isn't an open Sandcastle issue`;
  if (building.has(issueNumber)) {
    return `#${issueNumber} is labelled ${BUILDING_LABEL}, so another run is building it or passing on its PR`;
  }
  if (pr.isDraft) return "it's a draft";
  if (hasLabel(pr, NEEDS_HUMAN)) return `it's labelled ${NEEDS_HUMAN}`;
  if (pr.author !== host) return `${pr.author ?? "a deleted account"} opened it, not ${host}`;
  if (!pr.body.includes(PR_MARKER)) return "its body doesn't carry the Sandcastle PR marker";
  if (pr.truncated) return "it has more reviews, threads or checks than one read holds";
  return undefined;
}

// What every PR in one sweep is judged against, read once: the host's login,
// the in-scope issues, their numbers, the ones labelled sandcastle:building
// and whether this run follows hand-offs. sweepPullRequests and the status
// command (lib/status.mts, #65) both read it through sweepContext, so they
// judge each PR against the same things.
export type SweepContext = {
  host: string;
  issues: { number: number; labels: string[] }[];
  inScope: ReadonlySet<number>;
  building: ReadonlySet<number>;
  handOffs: boolean;
};

// Reads the host's login, the in-scope issues and whether this run follows
// hand-offs, in that order, for sweepPullRequests and the status command (#65).
export function sweepContext(github: Pick<FollowUpGitHub, "hostLogin" | "inScopeIssues" | "followsHandOffs">): SweepContext {
  const host = github.hostLogin();
  const issues = github.inScopeIssues();
  const inScope = new Set(issues.map((issue) => issue.number));
  const building = new Set(issues.filter((issue) => hasLabel(issue, BUILDING_LABEL)).map((issue) => issue.number));
  const handOffs = github.followsHandOffs();
  return { host, issues, inScope, building, handOffs };
}

// Whether the sweep goes on to `decide` about a PR, without writing anything
// (#65): "swept" with what it follows the PR up as, "skipped" with why
// (`unknown` when an owner check couldn't answer, so a follow-up run ends
// red), or "restore" when a stranger removed the PR's hand-back label and the
// sweep puts it back, leaving the PR alone this round.
export type SweepAdmission =
  | { kind: "swept"; subject: SweepSubject }
  | { kind: "skipped"; reason: string; unknown: boolean }
  | { kind: "restore"; label: string; reason: string };

// The checks sweepPullRequests makes before `decide`, in its order:
// sweepSkipReason, the subject, the hand-off approval and the needs-human
// origin check. Taken out of the sweep's loop so the status command (#65)
// gives the sweep's own answer; it only reads, and the sweep carries out a
// restore itself. Events are read once, and body edits only for a hand-off PR.
export function admitToSweep(
  pr: SweepPullRequest,
  context: SweepContext,
  github: Pick<FollowUpGitHub, "isOwner" | "pullRequestEvents" | "pullRequestBodyEdits">,
): SweepAdmission {
  const { inScope, host, building, handOffs } = context;
  const skip = sweepSkipReason(pr, inScope, host, building, handOffs);
  if (skip !== undefined) return { kind: "skipped", reason: skip, unknown: false };
  const subject = sweepSubject(pr, inScope, host, handOffs);
  if (subject === undefined) throw new Error(`PR #${pr.number} passed the sweep's checks with nothing to follow it up as`);
  const events = github.pullRequestEvents(pr.number);
  // Only the owner's own label, on a PR nobody else has renamed or edited
  // since, hands a PR to the sweep (#58), as the Sandcastle label does an
  // issue. A stranger's is reported and written to nowhere.
  if (subject.kind === "pull-request") {
    const approved = approval(FOLLOW_UP_LABEL, events, github.pullRequestBodyEdits(pr.number), github.isOwner);
    if (!approved.approved) return { kind: "skipped", reason: approved.reason, unknown: approved.unknown === true };
  }
  // A stranger's removal of the PR's hand-back label isn't a re-queue
  // (#146): the sweep puts the label back and leaves the PR alone this round.
  const origin = labelOriginFixes(pr.labels, events, github.isOwner, PR_LABEL_RULES);
  if (origin.unknown.length > 0) {
    return { kind: "skipped", reason: `couldn't check whether the repository owner removed ${NEEDS_HUMAN}`, unknown: true };
  }
  const restore = origin.fixes.find((fix) => fix.action === "restore");
  if (restore !== undefined) return { kind: "restore", label: restore.label, reason: restore.reason };
  return { kind: "swept", subject };
}

// What the sweep does about one PR, decided by `decide`.
export type SweepDecision =
  | { action: "wait"; reason: string }
  | { action: "request-review" }
  | { action: "update-branch" }
  | { action: "needs-pass"; reasons: string[] }
  | { action: "leave"; reason: string };

// What the sweep does about a PR that isn't skipped (see sweepSkipReason):
// flag one with conflicts for a later pass at once, wait while CI is still
// running, flag one with a red check or an unresolved bot or confirmed-owner
// thread (the same threads the follow-up role answers via threadsForRole, so
// a pass actually runs for an owner thread rather than leaving it stranded,
// #81), wait while Copilot's review is in flight, ask Copilot again once CI
// has been done for a while with no review or pending request, update a
// settled PR that's only behind main, or leave a clean or merge-blocked one
// alone. `isOwner` defaults to never-owner so a caller that doesn't pass it
// (most tests) sees every non-bot thread as a human's, as before this
// parameter existed. With `hostLogin`, a bot or owner thread the host already
// answered (answeredByHost) isn't counted: the pass declined it or replied and
// left it open for a person, and counting it would hold the PR at needs-pass,
// which no pass handles, so it would never be updated or re-reviewed.
export function decide(
  pr: SweepPullRequest,
  now: number,
  isOwner: IsOwner = () => false,
  hostLogin?: string,
): SweepDecision {
  // GitHub runs no pull_request workflows on a PR it can't merge, so a head
  // pushed while it conflicts gets no checks: waiting on them would hide the
  // conflict for good.
  if (pr.mergeStateStatus === "DIRTY") {
    const red = pr.checks.filter((check) => check.completed && !check.green).map((check) => `check ${check.name} is red`);
    return { action: "needs-pass", reasons: ["it has merge conflicts", ...red] };
  }
  if (pr.checks.length === 0) return { action: "wait", reason: "no checks have reported" };
  if (pr.checks.some((check) => !check.completed)) return { action: "wait", reason: "checks are still running" };

  // Red checks and bot/owner threads don't depend on Copilot reviewing this
  // head, so they're flagged before waiting on it: GitHub can drop the one
  // re-request (Copilot's review budget, ADR 0004), and every update-branch
  // makes a head Copilot hasn't seen, so waiting would hide them for good.
  const reasons = pr.checks.filter((check) => !check.green).map((check) => `check ${check.name} is red`);
  const open = pr.threads.filter((thread) => !thread.resolved && (thread.byBot || isOwner(thread.author) === true));
  const unreadable = open.filter((thread) => unjudgeable(thread, isOwner, hostLogin)).length;
  const botThreads = open.filter((thread) => thread.byBot && !unjudgeable(thread, isOwner, hostLogin) && !answeredByHost(thread, isOwner, hostLogin)).length;
  if (botThreads > 0) reasons.push(`${botThreads} unresolved bot thread(s)`);
  // A thread the repository owner opened is the follow-up role's to answer
  // (threadsForRole), not left waiting on a person forever: without this, a
  // settled PR whose only open thread is the owner's never needs a pass, so
  // nothing ever answers it (#81's follow-up review).
  const ownerThreads = open.filter(
    (thread) => !thread.byBot && !unjudgeable(thread, isOwner, hostLogin) && !answeredByHost(thread, isOwner, hostLogin),
  ).length;
  if (ownerThreads > 0) reasons.push(`${ownerThreads} unresolved owner thread(s)`);
  if (reasons.length > 0) return { action: "needs-pass", reasons };
  if (unreadable > 0) return { action: "wait", reason: `${unreadable} thread(s) have more comments than one read holds` };

  // A completed check with no time can't say when CI finished, so it leaves
  // ciDoneAt NaN and the PR is never re-requested on a guess.
  const doneAt = pr.checks.map((check) => (check.completedAt === null ? NaN : timestamp(check.completedAt)));
  const ciDoneAt = Math.max(...doneAt);
  const reviewed = pr.reviews.some((review) => isCopilot(review.author) && review.commitOid === pr.headRefOid);
  if (pr.reviewRequests.some(isCopilot)) return { action: "wait", reason: "Copilot's review is pending" };

  if (!reviewed) {
    // A request recorded after the head's first check completed means this
    // head was already asked about, whether or not GitHub kept the request:
    // that's what makes it once per head, and why the log then says a person
    // has to step in. The first completion, not the last, because a rerun
    // job or a label's review check can complete after the request on the
    // same head; the request GitHub makes when the PR opens comes before any.
    const firstDoneAt = Math.min(...doneAt);
    const askedSince = pr.copilotRequestedAt.some((requestedAt) => timestamp(requestedAt) >= firstDoneAt);
    if (askedSince) {
      return { action: "wait", reason: "Copilot hasn't reviewed the head since the one re-request, so a person needs to ask it" };
    }
    if (now - ciDoneAt > COPILOT_REREQUEST_AFTER_MS) return { action: "request-review" };
    return { action: "wait", reason: "Copilot hasn't reviewed the head yet" };
  }

  if (pr.mergeStateStatus === "BEHIND") return { action: "update-branch" };
  return { action: "leave", reason: `it's settled and ${pr.mergeStateStatus}` };
}

// The issue's latest Sandcastle PR among `prs` (the highest number among
// those isSandcastlePullRequest accepts on one of the issue's branches),
// returned only when it closed without merging (state "CLOSED"). Undefined
// when the latest such PR merged, or none exists.
export function closedWithoutMerging(
  prs: readonly ClosedPullRequest[],
  issueNumber: number,
  host: string,
): ClosedPullRequest | undefined {
  const latest = prs
    .filter((pr) => isSandcastlePullRequest(pr, host) && isIssueBranch(pr.headRefName, issueNumber))
    .reduce<ClosedPullRequest | undefined>((newest, pr) => (newest === undefined || pr.number > newest.number ? pr : newest), undefined);
  return latest?.state === "CLOSED" ? latest : undefined;
}

// The hand-back comment for an issue whose latest PR closed without merging.
// Its first sentence is the issue's own wording, word for word (see the
// "Closed without merging" acceptance criterion).
export function closedPrHandBackComment(pr: ClosedPullRequest): string {
  return (
    `PR #${pr.number} was closed without merging; remove the label to rebuild. ` +
    `Its branch \`${pr.headRefName}\` is deleted when the issue is next built, so the rebuild starts from \`main\`.`
  );
}

// Whether a person removed sandcastle:needs-human after `pr` closed, which
// is how they re-queue an issue the closed PR handed back, agreeing to
// rebuild it from main.
function requeuedSince(pr: ClosedPullRequest, timeline: readonly TimelineLabelEvent[]): boolean {
  const requeuedAt = Math.max(
    -Infinity,
    ...timeline
      .filter((event) => event.event === "unlabeled" && event.label.toLowerCase() === NEEDS_HUMAN)
      .map((event) => timestamp(event.createdAt)),
  );
  return timestamp(pr.closedAt) <= requeuedAt;
}

function closedPrReason(pr: ClosedPullRequest): string {
  return `PR #${pr.number} was closed without merging`;
}

// What the follow-up sweep needs from GitHub; tests pass a stub.
export type FollowUpGitHub = {
  hostLogin(): string;
  openPullRequests(): SweepPullRequest[];
  closedPullRequests(author: string): ClosedPullRequest[];
  // live: lib/queue.mts#loadQueue(), so the sweep sees only this run's
  // scope, approved by the owner (#146).
  inScopeIssues(): { number: number; labels: string[] }[];
  // The labels the issue carries now, read fresh just before a write to its PR:
  // the sweep's `inScopeIssues` snapshot is older than the per-PR reads (#53).
  // live: issueLabels(issueNumber).
  issueLabels(issueNumber: number): string[];
  labelTimeline(issueNumber: number): TimelineLabelEvent[];
  requestCopilotReview(pullRequestId: string): void;
  updateBranch(number: number, expectedHeadSha: string): void;
  // live: handBack({ kind: "issue", number: issueNumber }, NEEDS_HUMAN, reason, body).
  handBack(issueNumber: number, reason: string, body: string): void;
  // Tri-state owner check for a PR's label origin (lib/queue.mts#labelOriginFixes). live: pushAccess(login).
  isOwner: IsOwner;
  // The PR's labeled/unlabeled/renamed events, for labelOriginFixes. live:
  // issueEvents(number) (PRs share the issue events endpoint).
  pullRequestEvents(number: number): IssueEvent[];
  // Puts back a PR's hand-back label someone else removed. live: gh pr edit.
  addPullRequestLabel(number: number, label: string): void;
  // Whether this run follows hand-off PRs (#58). live: followsHandOffs(activeQueueScope()).
  followsHandOffs(): boolean;
  // The labels a PR carries now, read fresh just before a write to it. live: labelsOn(number).
  pullRequestLabels(number: number): string[];
  // The edits to a PR's body, for the hand-off approval. live: bodyEdits(number, ..., "pullRequest").
  pullRequestBodyEdits(number: number): ContentEdit[];
};

export const liveFollowUpGitHub: FollowUpGitHub = {
  hostLogin: () => signedInHostLogin(),
  openPullRequests: () => openPullRequestsForSweep(),
  closedPullRequests: (author) => closedPullRequests(author),
  inScopeIssues: () => loadQueue().map((issue) => ({ number: issue.number, labels: issue.labels })),
  issueLabels: (issueNumber) => issueLabels(issueNumber),
  labelTimeline: (issueNumber) => labelTimeline(issueNumber),
  requestCopilotReview: (pullRequestId) => requestCopilotReview(pullRequestId),
  updateBranch: (number, expectedHeadSha) => updatePullRequestBranch(number, expectedHeadSha),
  handBack: (issueNumber, reason, body) => handBack({ kind: "issue", number: issueNumber }, NEEDS_HUMAN, reason, body),
  isOwner: ownerCheck(() => signedInHostLogin(), (login) => pushAccess(login)),
  pullRequestEvents: (number) => issueEvents(number),
  addPullRequestLabel: (number, label) => addPullRequestLabel(number, label),
  followsHandOffs: () => followsHandOffs(activeQueueScope()),
  pullRequestLabels: (number) => labelsOn(number),
  pullRequestBodyEdits: (number) => bodyEdits(number, undefined, undefined, "pullRequest"),
};

// What the sweep found that needs an agent: the numbers of the PRs it logged
// as needing a follow-up pass (#147's early exit reads this, so a round with
// one of these still has work), and those same PRs as PassTargets for
// lib/follow-up-pass.mts#followUpPassPhase to run a pass on. A failed sweep
// (see followUpPhase) returns both empty, never treated as work found.
export type SweepResult = { needsPass: number[]; passes: PassTarget[] };

// The PRs this run's sweeps found have carried REVIEW_LABEL (labelForReview).
const carriedReviewLabel = new Set<number>();

// Reads the host's login, the in-scope issues and the open PRs once, then
// for each PR either skips it (sweepSkipReason, which also skips a PR whose
// issue is labelled sandcastle:building) or applies `decide`, logging what
// happened. A PR whose sandcastle:needs-human someone other than the
// repository owner removed gets it back instead, and is left alone (#146).
// Each PR runs in its own try/catch, so one failure doesn't stop the rest.
// An updated PR reaches `outcomes` as "updated", and every PR that reached
// `decide` with unresolved threads opened by someone other than the
// repository owner or a bot (the same test lib/follow-up-pass.mts#threadsForRole
// uses) replaces `waiting`'s list, so the run report shows the latest sweep's
// view, and `unlabelled` drops every PR no longer open. Once that's done, and
// only when `handBackClosed` is true, hands back any in-scope issue, not
// labelled sandcastle:needs-human and with no open PR, whose latest Sandcastle
// PR closed without merging (closedWithoutMerging), each in its own try/catch
// too. A follow-up-only run passes false (#53): it touches only open PRs, so it
// and a full run can't both hand back one issue. Every swept PR
// (sweepSkipReason applies isSandcastlePullRequest's tests) that has never
// carried REVIEW_LABEL gets it first (labelForReview). A hand-off PR
// (sweepSubject) is swept only when approval says the owner's
// sandcastle:follow-up is undisturbed, read from the same events as the
// needs-human origin check (#58). `onPrError` hears about each PR whose
// follow-up threw, or whose label origin couldn't be checked, after the
// warning is logged, so a follow-up-only run, which has no next round to
// sweep it again, can end red (#53).
export function sweepPullRequests(
  github: FollowUpGitHub = liveFollowUpGitHub,
  log: (line: string) => void = console.log,
  now: number = Date.now(),
  outcomes: OutcomeReport = outcomeReport,
  waiting: WaitingPrReport = waitingPrReport,
  unlabelled: Pick<UnlabelledPrReport, "record" | "resolve" | "retain"> = unlabelledPrReport,
  carried: Set<number> = carriedReviewLabel,
  handBackClosed: boolean = true,
  onPrError: (pr: number, error: unknown) => void = () => {},
): SweepResult {
  const context = sweepContext(github);
  const { host, issues } = context;
  const openPrs = github.openPullRequests();
  const needsPass: number[] = [];
  const passes: PassTarget[] = [];
  const waitingPrs: WaitingPrEntry[] = [];

  for (const pr of openPrs) {
    try {
      const admission = admitToSweep(pr, context, github);
      if (admission.kind === "skipped") {
        log(`  · PR #${pr.number} isn't swept: ${admission.reason}.`);
        // A follow-up run has no next round to sweep it again, so it ends red.
        if (admission.unknown) onPrError(pr.number, new Error(admission.reason));
        continue;
      }
      if (admission.kind === "restore") {
        github.addPullRequestLabel(pr.number, admission.label);
        log(`  ✋ PR #${pr.number}: ${admission.reason}, so it isn't swept.`);
        continue;
      }
      const { subject } = admission;
      labelForReview(pr, github, log, unlabelled, carried);
      // Not a bot's and not confirmed as the repository owner's: an owner
      // thread is the follow-up role's to answer (threadsForRole, and now
      // `decide` below), not left waiting on a person the way this count and
      // the run report's "waiting on a person" section describe it.
      const humanThreads = pr.threads.filter((thread) => !thread.resolved && !thread.byBot && github.isOwner(thread.author) !== true).length;
      if (humanThreads > 0) waitingPrs.push({ pr: pr.number, threads: humanThreads });
      const decision = decide(pr, now, github.isOwner, host);
      // `building` is a snapshot from before the per-PR reads above, so another
      // run may have claimed the issue since. Read it again just before a write
      // that run's pass would race (update-branch moves the head; a Copilot
      // request is noise on a PR it's passing on). A held PR is left for that
      // run, as sweepSkipReason leaves it. A hand-off PR's claim is on the PR.
      if (decision.action === "update-branch" || decision.action === "request-review") {
        // A hand-off PR on an issue's branch is claimed by a build of that
        // issue too, so both are read.
        // The branch's number may be a PR's (fix/65-...), which gh issue view
        // refuses, so both are read through the REST labels endpoint.
        const branchIssue = issueNumberOf(pr.headRefName);
        const claimLabels =
          subject.kind === "issue"
            ? github.issueLabels(subject.issueNumber)
            : [...github.pullRequestLabels(pr.number), ...(branchIssue === undefined ? [] : github.pullRequestLabels(branchIssue))];
        if (hasLabel({ labels: claimLabels }, BUILDING_LABEL)) {
          const claimed = subject.kind === "issue" ? "its issue" : "it or its branch's issue";
          log(`  · PR #${pr.number} isn't swept: ${claimed} became labelled ${BUILDING_LABEL} since the sweep began, so another run is working on it.`);
          continue;
        }
      }
      followUp(pr, decision, github, log, outcomes);
      if (decision.action === "needs-pass") {
        needsPass.push(pr.number);
        passes.push(passTarget(pr, decision.reasons, subject));
      }
    } catch (error) {
      log(`  ⚠ Couldn't follow up PR #${pr.number}, so it's swept again next round: ${error}`);
      onPrError(pr.number, error);
    }
  }
  waiting.replace(waitingPrs);
  unlabelled.retain(new Set(openPrs.map((pr) => pr.number)));
  if (!handBackClosed) return { needsPass, passes };

  // Any same-repo open PR on an issue's branch, the host's or not, means the
  // issue isn't waiting on a closed one.
  const withOpenPr = new Set(
    openPrs.filter((pr) => pr.isCrossRepository === false).flatMap((pr) => issueNumberOf(pr.headRefName) ?? []),
  );
  const candidates = issues.filter((issue) => !hasLabel(issue, NEEDS_HUMAN) && !withOpenPr.has(issue.number));
  if (candidates.length === 0) return { needsPass, passes };
  const closed = github.closedPullRequests(host);
  for (const issue of candidates) {
    try {
      const pr = closedWithoutMerging(closed, issue.number, host);
      if (pr === undefined) continue;
      // The same closed PR mustn't hand back an issue a person re-queued.
      if (requeuedSince(pr, github.labelTimeline(issue.number))) continue;
      github.handBack(issue.number, closedPrReason(pr), closedPrHandBackComment(pr));
      log(`  ✋ #${issue.number}: PR #${pr.number} was closed without merging, so the issue is handed back.`);
    } catch (error) {
      log(`  ⚠ Couldn't check whether #${issue.number}'s last PR closed without merging, so it's checked again next round: ${error}`);
    }
  }
  return { needsPass, passes };
}

// Adds REVIEW_LABEL to a Sandcastle PR that has never carried it, so Claude
// reviews one whose run stopped between `gh pr create` and the label, or one
// opened before #45 labelled the PRs it opens (#51). A PR that carried it
// before is left alone, as lib/github.mts#openPullRequest leaves one, so PR
// Auto-Merge's review cap holds. A failed timeline read only warns: every PR
// the cap unlabelled is read each round, so recording it would tell the owner
// to add the label by hand and bypass the cap. A failed add warns and goes in
// the run report. Neither throws, so the PR is still followed up, and the next
// round's sweep tries again; any outcome but a failure resolves the PR's entry.
// A PR found to have carried the label goes in `carried`, since a labeled
// event never leaves the timeline, so the cap's PRs are read once a run rather
// than every round.
function labelForReview(
  pr: SweepPullRequest,
  github: FollowUpGitHub,
  log: (line: string) => void,
  unlabelled: Pick<UnlabelledPrReport, "record" | "resolve">,
  carried: Set<number>,
): void {
  if (hasLabel(pr, REVIEW_LABEL) || carried.has(pr.number)) {
    unlabelled.resolve(pr.number);
    return;
  }
  let everLabelled: boolean;
  try {
    everLabelled = hasCarriedReviewLabel(github.labelTimeline(pr.number));
  } catch (error) {
    log(`  ⚠ Couldn't check whether PR #${pr.number} ever carried ${REVIEW_LABEL}; the next round's sweep checks again: ${error}`);
    return;
  }
  if (everLabelled) {
    carried.add(pr.number);
    unlabelled.resolve(pr.number);
    return;
  }
  try {
    github.addPullRequestLabel(pr.number, REVIEW_LABEL);
  } catch (error) {
    log(`  ⚠ Couldn't add ${REVIEW_LABEL} to PR #${pr.number}, so add it by hand for Claude to review it: ${error}`);
    unlabelled.record({ pr: pr.number, url: pr.url });
    return;
  }
  unlabelled.resolve(pr.number);
  log(`  🏷 PR #${pr.number} had never carried ${REVIEW_LABEL}: added it, so Claude reviews it`);
}

// One PR the sweep marked as needing a follow-up pass, with what
// lib/follow-up-pass.mts#runPass needs to start one: tests pin this directly,
// since the sweep's full SweepPullRequest carries far more than a pass reads.
export type PassTarget = {
  number: number;
  id: string;
  headRefName: string;
  headRefOid: string;
  // Undefined for a hand-off PR, whose claim and brief are the PR itself (#58).
  issueNumber: number | undefined;
  reasons: string[];
  // GitHub said the PR conflicts with main (DIRTY), so a pass merges main
  // in. A PR that's only behind isn't merged by a pass: the sweep updates it
  // on GitHub once it's settled.
  conflicted: boolean;
};

// What lib/follow-up-pass.mts#runPass reads of a needs-pass PR: the issue
// number of a Sandcastle PR's subject, and none for a hand-off PR's (#58).
function passTarget(pr: SweepPullRequest, reasons: string[], subject: SweepSubject): PassTarget {
  return {
    number: pr.number,
    id: pr.id,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    issueNumber: subject.kind === "issue" ? subject.issueNumber : undefined,
    reasons,
    conflicted: pr.mergeStateStatus === "DIRTY",
  };
}

// Carries out one PR's decision and logs it, recording an updated branch in
// the run report once GitHub has accepted the update.
function followUp(
  pr: SweepPullRequest,
  decision: SweepDecision,
  github: FollowUpGitHub,
  log: (line: string) => void,
  outcomes: OutcomeReport,
): void {
  switch (decision.action) {
    case "request-review":
      github.requestCopilotReview(pr.id);
      log(`  ↻ PR #${pr.number}: asked Copilot again to review ${pr.headRefOid.slice(0, 7)}`);
      return;
    case "update-branch":
      try {
        github.updateBranch(pr.number, pr.headRefOid);
      } catch (error) {
        if (!(error instanceof HeadMovedError)) throw error;
        // Another run, or a push, moved the head since the sweep read it:
        // nothing is wrong, and that run's own sweep or pass has it.
        log(`  · PR #${pr.number} isn't updated: its head moved since the sweep read it, so another run got there first.`);
        return;
      }
      outcomes.record({ kind: "pr", number: pr.number, outcome: "updated", detail: "was only behind main" });
      log(`  ⤴ PR #${pr.number} (${pr.headRefName}) was only behind main: updated it on GitHub`);
      return;
    case "needs-pass":
      log(`  ⚑ PR #${pr.number} needs a follow-up pass: ${decision.reasons.join("; ")}`);
      return;
    case "wait":
      log(`  ⏳ PR #${pr.number} waits: ${decision.reason}`);
      return;
    case "leave":
      log(`  ✓ PR #${pr.number} is left alone: ${decision.reason}`);
      return;
  }
}

// The follow-up sweep as main.mts runs it at the start of each round, before
// intake. A failure, such as GitHub's API being unavailable, is logged and
// the sweep runs again next round: it's housekeeping, never a reason to stop
// building. Returns { needsPass: [], passes: [] } for a failed sweep, so
// #147's early exit never treats a sweep failure as work found.
export function followUpPhase(
  sweep: () => SweepResult = () => sweepPullRequests(),
  warn: (message: string) => void = console.error,
): SweepResult {
  try {
    return sweep();
  } catch (error) {
    warn(`  ✗ Couldn't sweep the open pull requests, so they're swept again next round: ${error}`);
    return { needsPass: [], passes: [] };
  }
}

// Deletes the refs of `branch` that still hold the work of `issueNumber`'s
// latest Sandcastle PR, when that PR was closed without merging and a person
// has since re-queued the issue, so the build starts from main. Returns
// undefined when there's no such PR, or when its branch isn't the one being
// built (the build's branch never held that work). When nobody re-queued the
// issue since the PR closed (it closed after this round's sweep, or the
// sweep's hand-back failed), hands it back instead and throws, deleting
// nothing: the hand-back's comment is the only consent to discarding the
// work. Called from lib/build.mts#buildMarkedIssue, before createSandbox(),
// so a throw stops the build, uncounted, before any sandbox exists.
export function startFromMain(
  issueNumber: number,
  branch: string,
  base: string,
  github: Pick<FollowUpGitHub, "hostLogin" | "closedPullRequests" | "labelTimeline" | "handBack"> = liveFollowUpGitHub,
  refs?: BranchRefs,
): { pr: number; deleted: string[] } | undefined {
  const host = github.hostLogin();
  const pr = closedWithoutMerging(github.closedPullRequests(host), issueNumber, host);
  if (pr === undefined || pr.headRefName !== branch) return undefined;
  if (!requeuedSince(pr, github.labelTimeline(issueNumber))) {
    github.handBack(issueNumber, closedPrReason(pr), closedPrHandBackComment(pr));
    throw new Error(`${closedPrReason(pr)} and nobody has re-queued #${issueNumber} since, so it's handed back rather than rebuilt`);
  }
  return { pr: pr.number, deleted: discardClosedWork(branch, pr, base, refs) };
}

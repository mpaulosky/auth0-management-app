import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BranchRefs } from "./branches.mts";
import { BUILDING_LABEL, COPILOT_REVIEWER, FOLLOW_UP_LABEL, FOLLOW_UP_REPLY_MARKER, PR_MARKER, REVIEW_LABEL, SESSION_REPLY_MARKER } from "./config.mts";
import { HeadMovedError, type ClosedPullRequest, type ContentEdit, type IssueEvent, type PullRequestIdentity, type TimelineLabelEvent } from "./github.mts";
import {
  admitToSweep,
  closedPrHandBackComment,
  closedWithoutMerging,
  decide,
  followsHandOffs,
  followUpPhase,
  isCopilot,
  isSandcastlePullRequest,
  issueNumberOf,
  startFromMain,
  sweepContext,
  sweepPullRequests,
  sweepSkipReason,
  sweepSubject,
  type FollowUpGitHub,
  type SweepContext,
  type SweepPullRequest,
} from "./follow-up.mts";
import { approval } from "./queue.mts";
import { OutcomeReport, UnlabelledPrReport, WaitingPrReport } from "./report.mts";

const HOST = "sandcastle-bot";
const BRANCH = "feature/42-add-search";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const IN_SCOPE = new Set([42]);

// A settled, CLEAN, Sandcastle PR on issue #42's branch, reviewed by Copilot
// with every check green; tests override just the fields their scenario
// needs.
function pr(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  const number = overrides.number ?? 101;
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `Add search (#${number})`,
    author: HOST,
    body: `${PR_MARKER}\nCloses #42`,
    baseRefName: "main",
    headRefName: BRANCH,
    isCrossRepository: false,
    id: "PR_101",
    headRefOid: "a".repeat(40),
    isDraft: false,
    labels: [],
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }],
    threads: [],
    checks: [{ name: "build", completed: true, green: true, completedAt: "2026-10-10T09:00:00Z" }],
    copilotRequestedAt: [],
    truncated: false,
    ...overrides,
  };
}

const identity = (overrides: Partial<PullRequestIdentity> = {}): PullRequestIdentity => ({
  number: 101,
  author: HOST,
  body: `${PR_MARKER}\nCloses #42`,
  baseRefName: "main",
  headRefName: BRANCH,
  isCrossRepository: false,
  ...overrides,
});

const closedPr = (overrides: Partial<ClosedPullRequest> = {}): ClosedPullRequest => ({
  number: 10,
  author: HOST,
  body: `${PR_MARKER}\nCloses #42`,
  baseRefName: "main",
  headRefName: BRANCH,
  isCrossRepository: false,
  headRefOid: "a".repeat(40),
  state: "CLOSED",
  closedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("isCopilot", () => {
  for (const login of ["copilot-pull-request-reviewer[bot]", "Copilot", "copilot", "copilot-pull-request-reviewer"]) {
    it(`accepts GitHub's "${login}" spelling of Copilot's review account`, () => {
      assert.equal(isCopilot(login), true);
    });
  }

  it("rejects another bot's login", () => {
    assert.equal(isCopilot("github-advanced-security[bot]"), false);
  });

  it("rejects null", () => {
    assert.equal(isCopilot(null), false);
  });
});

describe("issueNumberOf", () => {
  for (const prefix of ["feature", "fix", "hotfix"]) {
    it(`reads the issue number from a ${prefix}/ branch`, () => {
      assert.equal(issueNumberOf(`${prefix}/42-add-search`), 42);
    });
  }

  it("is undefined for a branch whose prefix isn't feature, fix or hotfix", () => {
    assert.equal(issueNumberOf("chore/42-add-search"), undefined);
  });

  // The branch name reaches a shell elsewhere in the pipeline, so only a name
  // isIssueBranch (lib/branches.mts) itself accepts counts.
  it("is undefined for a branch name isIssueBranch refuses", () => {
    assert.equal(issueNumberOf("feature/42-Add-Search"), undefined);
  });
});

describe("isSandcastlePullRequest", () => {
  it("is true for a same-repo PR into main, authored by the host, carrying the marker, on an issue branch", () => {
    assert.equal(isSandcastlePullRequest(identity(), HOST), true);
  });

  it("is false for a PR from a fork", () => {
    assert.equal(isSandcastlePullRequest(identity({ isCrossRepository: true }), HOST), false);
  });

  it("is false for a PR not into main", () => {
    assert.equal(isSandcastlePullRequest(identity({ baseRefName: "develop" }), HOST), false);
  });

  it("is false for a PR the host didn't author", () => {
    assert.equal(isSandcastlePullRequest(identity({ author: "a-collaborator" }), HOST), false);
  });

  it("is false for a PR without PR_MARKER in its body, even from the host", () => {
    assert.equal(isSandcastlePullRequest(identity({ body: "Closes #42" }), HOST), false);
  });

  it("is false for a PR not on an issue branch", () => {
    assert.equal(isSandcastlePullRequest(identity({ headRefName: "chore/42-add-search" }), HOST), false);
  });
});

describe("sweepSkipReason", () => {
  it("has no skip reason for a PR the sweep should act on", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST), undefined);
  });

  it("skips a fork's PR", () => {
    assert.ok(sweepSkipReason(pr({ isCrossRepository: true }), IN_SCOPE, HOST));
  });

  it("skips a PR not into main", () => {
    assert.ok(sweepSkipReason(pr({ baseRefName: "develop" }), IN_SCOPE, HOST));
  });

  it("skips a PR not on an issue branch", () => {
    assert.ok(sweepSkipReason(pr({ headRefName: "chore/42-add-search" }), IN_SCOPE, HOST));
  });

  it("skips a PR whose issue isn't open and in scope", () => {
    assert.ok(sweepSkipReason(pr(), new Set(), HOST));
  });

  it("skips a draft", () => {
    assert.ok(sweepSkipReason(pr({ isDraft: true }), IN_SCOPE, HOST));
  });

  for (const label of ["sandcastle:needs-human", "Sandcastle:Needs-Human"]) {
    it(`skips a PR labelled ${label}`, () => {
      assert.ok(sweepSkipReason(pr({ labels: [label] }), IN_SCOPE, HOST));
    });
  }

  it("skips a PR the host didn't open", () => {
    assert.ok(sweepSkipReason(pr({ author: "a-collaborator" }), IN_SCOPE, HOST));
  });

  it("skips a PR without PR_MARKER", () => {
    assert.ok(sweepSkipReason(pr({ body: "Closes #42" }), IN_SCOPE, HOST));
  });

  it("skips a PR whose data was truncated, rather than deciding from part of it", () => {
    assert.ok(sweepSkipReason(pr({ truncated: true }), IN_SCOPE, HOST));
  });
});

describe("decide", () => {
  it("waits while a check hasn't completed, saying checks are still running", () => {
    const result = decide(pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] }), NOW);

    assert.deepEqual(result, { action: "wait", reason: "checks are still running" });
  });

  it("waits with no checks reported at all", () => {
    const result = decide(pr({ checks: [] }), NOW);

    assert.deepEqual(result, { action: "wait", reason: "no checks have reported" });
  });

  it("waits when Copilot's review is of an older commit and a request is still pending", () => {
    const result = decide(
      pr({ reviews: [{ author: COPILOT_REVIEWER, commitOid: "0".repeat(40) }], reviewRequests: [COPILOT_REVIEWER] }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  it("waits when Copilot has reviewed the head but is requested again", () => {
    const result = decide(
      pr({ reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }], reviewRequests: [COPILOT_REVIEWER] }),
      NOW,
    );

    assert.deepEqual(result, { action: "wait", reason: "Copilot's review is pending" });
  });

  it("asks Copilot again once CI has been done for over an hour with no review or pending request", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "request-review" });
  });

  it("keeps waiting at 59 minutes, short of the threshold", () => {
    const completedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  it("doesn't ask again once a request already followed the last time CI finished", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [],
        reviewRequests: [],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, {
      action: "wait",
      reason: "Copilot hasn't reviewed the head since the one re-request, so a person needs to ask it",
    });
  });

  // A rerun job, or the review check a label adds, completes after the
  // sweep's request on the same head; that mustn't make the head unasked.
  it("doesn't ask again when a check on the same head completes after the recorded request", () => {
    const firstDoneAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const rerunDoneAt = new Date(NOW - 90 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [],
        checks: [
          { name: "build", completed: true, green: true, completedAt: firstDoneAt },
          { name: "claude-review", completed: true, green: true, completedAt: rerunDoneAt },
        ],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.equal(result.action, "wait");
  });

  // The request GitHub makes when the PR opens comes before any check on the
  // head completes, so it isn't the sweep's one re-request.
  it("asks again when the only request came before any check on the head completed", () => {
    const requestedAt = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
    const completedAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const result = decide(
      pr({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt }], copilotRequestedAt: [requestedAt] }),
      NOW,
    );

    assert.deepEqual(result, { action: "request-review" });
  });

  // GitHub can drop the one re-request (Copilot's review budget, ADR 0004),
  // and a PR that waits on a review that never comes would otherwise hide a
  // conflict or a red check for good.
  it("flags a dirty PR as needing a follow-up pass even when Copilot never reviewed its head", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        mergeStateStatus: "DIRTY",
        reviews: [],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  // GitHub runs no pull_request workflows on a PR it can't merge, so a head
  // pushed while the PR conflicts gets no checks at all.
  it("flags a dirty PR with no checks reported as needing a follow-up pass, rather than waiting on checks", () => {
    const result = decide(pr({ mergeStateStatus: "DIRTY", checks: [] }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  it("flags a dirty PR whose checks are still running as needing a follow-up pass", () => {
    const result = decide(
      pr({ mergeStateStatus: "DIRTY", checks: [{ name: "build", completed: false, green: false, completedAt: null }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  // Every update-branch makes a new head, so Copilot's threads usually sit on
  // an earlier commit; they still need a pass whatever Copilot does next.
  it("flags an unresolved bot thread from a review of an earlier commit, without waiting on Copilot", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt = new Date(NOW - 30 * 60 * 1000).toISOString();
    const result = decide(
      pr({
        reviews: [{ author: COPILOT_REVIEWER, commitOid: "0".repeat(40) }],
        threads: [{ resolved: false, byBot: true, author: null }],
        checks: [{ name: "build", completed: true, green: true, completedAt }],
        copilotRequestedAt: [requestedAt],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved bot thread(s)"] });
  });

  it("flags a red check as needing a follow-up pass while Copilot's review is still pending", () => {
    const result = decide(
      pr({
        reviews: [],
        reviewRequests: [COPILOT_REVIEWER],
        checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }],
      }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["check lint is red"] });
  });

  it("updates a settled PR that's only behind main", () => {
    const result = decide(pr({ mergeStateStatus: "BEHIND" }), NOW);

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("flags a settled, dirty PR as needing a follow-up pass, naming merge conflicts", () => {
    const result = decide(pr({ mergeStateStatus: "DIRTY" }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["it has merge conflicts"] });
  });

  it("flags a settled PR with a red check as needing a follow-up pass, naming it", () => {
    const result = decide(
      pr({ checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }] }),
      NOW,
    );

    assert.deepEqual(result, { action: "needs-pass", reasons: ["check lint is red"] });
  });

  it("flags a settled PR with an unresolved bot thread as needing a follow-up pass, counting it", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: true, author: null }] }), NOW);

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved bot thread(s)"] });
  });

  // threadsForRole answers a thread the repository owner opened, so `decide`
  // must flag it too: otherwise the PR never gets a pass to answer it (#81).
  it("flags a settled PR with an unresolved owner thread as needing a follow-up pass, counting it", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] }), NOW, (login) => login === "owner");

    assert.deepEqual(result, { action: "needs-pass", reasons: ["1 unresolved owner thread(s)"] });
  });

  // Whether the thread's author is confirmed, not just non-bot, decides this:
  // an unresolved thread `isOwner` can't confirm is left alone here (it still
  // counts toward the sweep's waiting-on-a-person list, which errs the other
  // way on the same uncertainty).
  it("leaves a settled PR with an unresolved thread of unconfirmed ownership alone", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: "maybe-owner" }] }), NOW, () => undefined);

    assert.equal(result.action, "leave");
  });

  it("leaves a settled, clean PR with every thread resolved alone", () => {
    const result = decide(pr({ threads: [{ resolved: true, byBot: true, author: null }] }), NOW);

    assert.equal(result.action, "leave");
  });

  // Open human threads mean a human has joined the review; only they resolve
  // their own threads, so these never count toward a follow-up pass here.
  it("leaves a settled PR with only a human thread open alone, not needing a pass", () => {
    const result = decide(pr({ threads: [{ resolved: false, byBot: false, author: null }] }), NOW);

    assert.equal(result.action, "leave");
  });

  it("leaves a BLOCKED PR alone, naming the state in the reason", () => {
    const result = decide(pr({ mergeStateStatus: "BLOCKED" }), NOW);

    assert.equal(result.action, "leave");
    assert.match((result as { reason: string }).reason, /BLOCKED/);
  });
});

describe("decide's host-answered bot threads", () => {
  const answered = { author: HOST, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined: out of scope.` };
  type Recent = { author: string | null; body: string; byBot?: boolean };
  const recent = (comments: Recent[]) => comments.map((comment) => ({ byBot: false, ...comment }));
  const botThread = (...comments: Recent[]) => ({
    resolved: false,
    byBot: true,
    author: "copilot-pull-request-reviewer",
    recentComments: recent(comments),
  });
  const ownerThread = (...comments: Recent[]) => ({ resolved: false, byBot: false, author: "owner", recentComments: recent(comments) });
  const isOwnerLogin = (login: string | null) => login === "owner";

  it("updates a behind PR whose only open bot thread the host already answered", () => {
    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [botThread(answered)] }), NOW, () => false, HOST);

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("counts the bot thread when the run doesn't know the host's login", () => {
    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [botThread(answered)] }), NOW);

    assert.equal(result.action, "needs-pass");
  });

  it("counts a bot thread whose newest comment is the bot's own", () => {
    const result = decide(
      pr({ mergeStateStatus: "BEHIND", threads: [botThread(answered, { author: "copilot-pull-request-reviewer", body: "Still wrong.", byBot: true })] }),
      NOW,
      () => false,
      HOST,
    );

    assert.equal(result.action, "needs-pass");
  });

  it("waits rather than counting a thread strangers pushed the host's reply out of", () => {
    const strangers = Array.from({ length: 10 }, () => ({ author: "stranger", body: "me too" }));
    const thread = { ...botThread(...strangers), recentTruncated: true as const };

    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [thread] }), NOW, () => false, HOST);

    assert.equal(result.action, "wait");
  });

  it("counts a truncated thread whose window still holds the bot's own newest comment", () => {
    const thread = {
      ...botThread({ author: "copilot-pull-request-reviewer", body: "Still wrong.", byBot: true }),
      recentTruncated: true as const,
    };

    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [thread] }), NOW, () => false, HOST);

    assert.equal(result.action, "needs-pass");
  });

  it("counts a thread where a stranger quotes the marker", () => {
    const result = decide(
      pr({ mergeStateStatus: "BEHIND", threads: [botThread({ author: "stranger", body: answered.body })] }),
      NOW,
      () => false,
      HOST,
    );

    assert.equal(result.action, "needs-pass");
  });

  it("still treats a bot thread as answered when a stranger replied after the host", () => {
    const result = decide(
      pr({ mergeStateStatus: "BEHIND", threads: [botThread(answered, { author: "stranger", body: "me too" })] }),
      NOW,
      () => false,
      HOST,
    );

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("updates a behind PR whose only open owner thread the host already answered", () => {
    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [ownerThread(answered)] }), NOW, isOwnerLogin, HOST);

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("still treats an owner thread as answered when a stranger replied after the host", () => {
    const result = decide(
      pr({ mergeStateStatus: "BEHIND", threads: [ownerThread(answered, { author: "stranger", body: "me too" })] }),
      NOW,
      isOwnerLogin,
      HOST,
    );

    assert.deepEqual(result, { action: "update-branch" });
  });

  it("counts an owner thread the owner replied to after the host", () => {
    const result = decide(
      pr({ mergeStateStatus: "BEHIND", threads: [ownerThread(answered, { author: "owner", body: "Not good enough." })] }),
      NOW,
      isOwnerLogin,
      HOST,
    );

    assert.equal(result.action, "needs-pass");
  });

  it("treats the owner's session reply (SESSION_REPLY_MARKER, posted as the host) as an answer", () => {
    const session = { author: HOST, body: `Declined.\n\n${SESSION_REPLY_MARKER}` };

    const result = decide(pr({ mergeStateStatus: "BEHIND", threads: [botThread(session)] }), NOW, () => false, HOST);

    assert.deepEqual(result, { action: "update-branch" });
  });
});

describe("closedWithoutMerging", () => {
  it("gives the issue's latest Sandcastle PR when it closed without merging", () => {
    const prs = [closedPr({ number: 9, state: "MERGED" }), closedPr({ number: 10, state: "CLOSED" })];

    assert.deepEqual(closedWithoutMerging(prs, 42, HOST), prs[1]);
  });

  it("is undefined when the issue's latest PR merged", () => {
    const prs = [closedPr({ number: 10, state: "MERGED" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when a newer merged PR follows the closed one", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED" }), closedPr({ number: 11, state: "MERGED" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when none of the closed PRs are the host's", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED", author: "a-collaborator" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });

  it("is undefined when none of the closed PRs are on the issue's branch", () => {
    const prs = [closedPr({ number: 10, state: "CLOSED", headRefName: "feature/7-other-issue" })];

    assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
  });
});

describe("closedPrHandBackComment", () => {
  it("gives the issue's exact wording, naming the PR and that the rebuild starts from main", () => {
    const comment = closedPrHandBackComment(closedPr({ number: 99 }));

    assert.match(comment, /^PR #99 was closed without merging; remove the label to rebuild\./);
    assert.match(comment, new RegExp(BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(comment, /main/);
  });
});

// A FollowUpGitHub stub serving `prs`, `closed` and `issues`, and recording
// every write the sweep makes.
function stubGithub({
  prs = [pr()],
  closed = [],
  issues = [{ number: 42, labels: [] }],
  host = HOST,
  timelines = {},
  isOwner = () => true,
  pullRequestEvents = () => [],
  failTimelineFor = [],
  failAddLabelFor = [],
  labelsNow = {},
  followsHandOffs = true,
  pullRequestBodyEdits = () => [],
  prLabelsNow = {},
}: {
  prs?: SweepPullRequest[];
  closed?: ClosedPullRequest[];
  issues?: { number: number; labels: string[] }[];
  host?: string;
  timelines?: Record<number, TimelineLabelEvent[]>;
  isOwner?: (login: string | null) => boolean | undefined;
  pullRequestEvents?: (number: number) => IssueEvent[];
  // PR numbers whose label timeline read, or label add, throws.
  failTimelineFor?: number[];
  failAddLabelFor?: number[];
  // Labels an issue carries when the sweep re-reads them, where they differ from `issues`.
  labelsNow?: Record<number, string[]>;
  // Whether the run follows hand-off PRs (#58), the edits to a PR's body, and
  // the labels a PR carries when the sweep re-reads them, where they differ from its own.
  followsHandOffs?: boolean;
  pullRequestBodyEdits?: (number: number) => ContentEdit[];
  prLabelsNow?: Record<number, string[]>;
} = {}) {
  const requestedReviews: string[] = [];
  const updatedBranches: { number: number; expectedHeadSha: string }[] = [];
  const handBacks: { issueNumber: number; reason: string; body: string }[] = [];
  const closedCalls: string[] = [];
  const addedPrLabels: { number: number; label: string }[] = [];
  const labelReads: number[] = [];
  const prLabelReads: number[] = [];
  const github: FollowUpGitHub = {
    hostLogin: () => host,
    openPullRequests: () => prs,
    closedPullRequests: (author) => {
      closedCalls.push(author);
      return closed;
    },
    inScopeIssues: () => issues,
    issueLabels: (issueNumber) => {
      labelReads.push(issueNumber);
      return labelsNow[issueNumber] ?? issues.find((issue) => issue.number === issueNumber)?.labels ?? [];
    },
    labelTimeline: (issueNumber) => {
      if (failTimelineFor.includes(issueNumber)) throw new Error("gh api failed: HTTP 502");
      return timelines[issueNumber] ?? [];
    },
    requestCopilotReview: (pullRequestId) => void requestedReviews.push(pullRequestId),
    updateBranch: (number, expectedHeadSha) => void updatedBranches.push({ number, expectedHeadSha }),
    handBack: (issueNumber, reason, body) => void handBacks.push({ issueNumber, reason, body }),
    isOwner,
    pullRequestEvents,
    addPullRequestLabel: (number, label) => {
      if (failAddLabelFor.includes(number)) throw new Error("gh pr edit failed: HTTP 502");
      addedPrLabels.push({ number, label });
    },
    followsHandOffs: () => followsHandOffs,
    pullRequestLabels: (number) => {
      prLabelReads.push(number);
      return prLabelsNow[number] ?? prs.find((candidate) => candidate.number === number)?.labels ?? [];
    },
    pullRequestBodyEdits,
  };
  return { github, requestedReviews, updatedBranches, handBacks, closedCalls, addedPrLabels, labelReads, prLabelReads };
}

describe("sweepPullRequests", () => {
  it("skips a PR a collaborator opened from a matching branch, touching nothing", () => {
    const { requestedReviews, updatedBranches, handBacks, github } = stubGithub({
      prs: [pr({ author: "a-collaborator", mergeStateStatus: "BEHIND" })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(handBacks, []);
  });

  it("skips the host's own PR on a matching branch when it lacks PR_MARKER", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ body: "Closes #42", mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  for (const label of ["sandcastle:needs-human", "Sandcastle:Needs-Human"]) {
    it(`skips a PR labelled ${label}`, () => {
      const { updatedBranches, github } = stubGithub({ prs: [pr({ labels: [label], mergeStateStatus: "BEHIND" })] });

      sweepPullRequests(github, () => {}, NOW);

      assert.deepEqual(updatedBranches, []);
    });
  }

  it("skips a draft PR", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ isDraft: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("skips a fork PR", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ isCrossRepository: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("skips a truncated PR, rather than deciding from part of its data", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ truncated: true, mergeStateStatus: "BEHIND" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("updates a settled PR that's only behind main, and logs its number", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
    assert.ok(lines.some((line) => line.includes("#101")), lines.join("\n"));
  });

  it("doesn't update a PR that's dirty, logging it as needing a follow-up pass instead", () => {
    const { updatedBranches, github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })] });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("needs a follow-up pass")), lines.join("\n"));
  });

  it("doesn't update a PR with a red check", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", checks: [{ name: "lint", completed: true, green: false, completedAt: "2026-10-10T09:00:00Z" }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("doesn't update a PR with an unresolved bot thread", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", threads: [{ resolved: false, byBot: true, author: null }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  it("doesn't touch a PR whose checks are still running", () => {
    const { updatedBranches, requestedReviews, github } = stubGithub({
      prs: [pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("doesn't touch a PR with no Copilot review of its head yet, and no pending request", () => {
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt: "2026-10-10T11:58:00Z" }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
  });

  it("asks Copilot again exactly once when CI has been done for over an hour with no review or request", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, ["PR_101"]);
  });

  it("doesn't ask again at 59 minutes", () => {
    const completedAt = new Date(NOW - 59 * 60 * 1000).toISOString();
    const { requestedReviews, github } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(requestedReviews, []);
  });

  // The recorded event makes exactly one re-request happen across rounds and
  // runs, even once GitHub drops the request (Copilot's review budget used
  // up, ADR 0004).
  it("asks Copilot again only once across two sweeps in a row", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const requestedAt: string[] = [];
    const requestedReviews: string[] = [];
    const github: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [
        pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }], copilotRequestedAt: [...requestedAt] }),
      ],
      closedPullRequests: () => [],
      inScopeIssues: () => [{ number: 42, labels: [] }],
      issueLabels: () => [],
      labelTimeline: () => [],
      requestCopilotReview: (id) => {
        requestedReviews.push(id);
        requestedAt.push(new Date(NOW).toISOString());
      },
      updateBranch: () => {},
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      followsHandOffs: () => false,
      pullRequestLabels: () => [],
      pullRequestBodyEdits: () => [],
    };

    sweepPullRequests(github, () => {}, NOW);
    sweepPullRequests(github, () => {}, NOW + 1000);

    assert.equal(requestedReviews.length, 1);
  });

  it("leaves a settled, clean PR with every thread resolved alone", () => {
    const { updatedBranches, requestedReviews, github } = stubGithub({ prs: [pr({ threads: [{ resolved: true, byBot: true, author: null }] })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("leaves a settled PR with only a human thread open alone", () => {
    const { updatedBranches, github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: null }] })],
      isOwner: () => false,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(updatedBranches, []);
  });

  // #81's follow-up review: a settled PR whose only open thread is the
  // repository owner's must still get a follow-up pass, since that's the
  // only thing that ever answers an owner thread (threadsForRole). Before
  // this, `decide` classified threads by byBot alone and never saw the
  // owner, so the PR sat with the thread unanswered forever.
  it("flags a settled PR with only an unresolved owner thread as needing a follow-up pass", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: (login) => login === "owner",
    });

    const { needsPass, passes } = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(needsPass, [101]);
    assert.equal(passes.length, 1);
    assert.equal(passes[0]?.number, 101);
  });

  it("still updates the next PR when one PR's update fails", () => {
    const failing = pr({ number: 101, mergeStateStatus: "BEHIND" });
    const ok = pr({
      number: 102,
      id: "PR_102",
      headRefOid: "b".repeat(40),
      headRefName: "feature/43-add-sorting",
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }],
    });
    const updated: { number: number; expectedHeadSha: string }[] = [];
    const github: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [failing, ok],
      closedPullRequests: () => [],
      inScopeIssues: () => [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
      ],
      issueLabels: () => [],
      labelTimeline: () => [],
      requestCopilotReview: () => {},
      updateBranch: (number, expectedHeadSha) => {
        if (number === 101) throw new Error("gh api failed: HTTP 422");
        updated.push({ number, expectedHeadSha });
      },
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      followsHandOffs: () => false,
      pullRequestLabels: () => [],
      pullRequestBodyEdits: () => [],
    };
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(updated, [{ number: 102, expectedHeadSha: "b".repeat(40) }]);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("422")), lines.join("\n"));
  });

  it("hands an issue back when its only PR closed without merging", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW);

    assert.equal(handBacks.length, 1);
    assert.equal(handBacks[0]!.issueNumber, 42);
    assert.match(handBacks[0]!.body, /PR #10 was closed without merging; remove the label to rebuild\./);
  });

  it("doesn't hand back when the issue's latest PR merged", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr({ state: "MERGED" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when a newer merged PR followed the closed one", () => {
    const closed = [closedPr({ number: 10, state: "CLOSED" }), closedPr({ number: 11, state: "MERGED" })];
    const { handBacks, github } = stubGithub({ prs: [], closed });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when an open PR already exists for the issue", () => {
    const { handBacks, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], closed: [closedPr()] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back an issue already labelled sandcastle:needs-human", () => {
    const { handBacks, github } = stubGithub({
      prs: [],
      closed: [closedPr()],
      issues: [{ number: 42, labels: ["sandcastle:needs-human"] }],
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back again once a person removed sandcastle:needs-human after the closed PR, re-queueing the issue", () => {
    const { handBacks, github } = stubGithub({
      prs: [],
      closed: [closedPr()],
      timelines: { 42: [{ event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-02T00:00:00Z" }] },
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("doesn't hand back when the closed PR isn't the host's", () => {
    const { handBacks, github } = stubGithub({ prs: [], closed: [closedPr({ author: "a-collaborator" })] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(handBacks, []);
  });

  it("reads the closed pull requests only when an in-scope issue could need a hand-back", () => {
    const { closedCalls, github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], closed: [] });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(closedCalls, []);
  });

  // Label origin applies to PR-level hand-backs too, not just issues (#146,
  // "Label origin"): a stranger removing sandcastle:needs-human from a PR
  // mustn't let the sweep touch it as if a human had re-queued it.
  it("re-adds needs-human to a PR whose removal wasn't the owner's, taking no other action on it", () => {
    const strangerRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    const { updatedBranches, requestedReviews, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: (login) => login !== "stranger",
      pullRequestEvents: () => strangerRemoved,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(addedPrLabels, [{ number: 101, label: "sandcastle:needs-human" }]);
    assert.deepEqual(updatedBranches, []);
    assert.deepEqual(requestedReviews, []);
  });

  it("sweeps a PR as usual when the owner removed its needs-human", () => {
    const ownerRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "owner", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    // Carries review:claude, so the sweep's review label (#51) adds nothing.
    const { updatedBranches, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND", labels: [REVIEW_LABEL] })],
      isOwner: (login) => login === "owner",
      pullRequestEvents: () => ownerRemoved,
    });

    sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
  });

  it("leaves a PR alone, with no write, when it can't check who removed its needs-human", () => {
    const ghostRemoved: IssueEvent[] = [
      { event: "unlabeled", actor: "ghost", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ];
    const { updatedBranches, addedPrLabels, github } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: () => undefined,
      pullRequestEvents: () => ghostRemoved,
    });
    const lines: string[] = [];

    sweepPullRequests(github, (line) => lines.push(line), NOW);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes("couldn't check")), lines.join("\n"));
  });

  // AC: an updated PR reaches the run report (lib/report.mts) as "updated".
  it("records 'updated' for a settled PR that's only behind main, once updateBranch has returned", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const outcomes = new OutcomeReport();

    sweepPullRequests(github, () => {}, NOW, outcomes);

    assert.deepEqual(outcomes.items(), [{ kind: "pr", number: 101, outcome: "updated", detail: "was only behind main" }]);
  });

  it("doesn't record anything when updateBranch fails", () => {
    const failing: FollowUpGitHub = {
      hostLogin: () => HOST,
      openPullRequests: () => [pr({ mergeStateStatus: "BEHIND" })],
      closedPullRequests: () => [],
      inScopeIssues: () => [{ number: 42, labels: [] }],
      issueLabels: () => [],
      labelTimeline: () => [],
      requestCopilotReview: () => {},
      updateBranch: () => {
        throw new Error("gh api failed: HTTP 422");
      },
      handBack: () => {},
      isOwner: () => true,
      pullRequestEvents: () => [],
      addPullRequestLabel: () => {},
      followsHandOffs: () => false,
      pullRequestLabels: () => [],
      pullRequestBodyEdits: () => [],
    };
    const outcomes = new OutcomeReport();

    sweepPullRequests(failing, () => {}, NOW, outcomes);

    assert.deepEqual(outcomes.items(), []);
  });

  // AC: "open Sandcastle PRs left waiting on unresolved human review threads,
  // with links" — the waiting list the run report renders (lib/report.mts).
  it("adds a PR to the waiting list, counting only its unresolved, non-bot threads", () => {
    const { github } = stubGithub({
      prs: [
        pr({
          threads: [
            { resolved: false, byBot: false, author: "stranger" },
            { resolved: true, byBot: false, author: "stranger" },
            { resolved: false, byBot: true, author: null },
          ],
        }),
      ],
      isOwner: () => false,
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), [{ pr: 101, threads: 1 }]);
  });

  // The waiting count must match lib/follow-up-pass.mts#threadsForRole's
  // classification: an owner-opened thread is the follow-up role's to
  // answer, never a person Sandcastle is waiting on.
  it("doesn't count an unresolved thread the repository owner opened", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "owner" }] })],
      isOwner: (login) => login === "owner",
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });

  it("excludes a skipped PR from the waiting list", () => {
    const { github } = stubGithub({ prs: [pr({ isDraft: true, threads: [{ resolved: false, byBot: false, author: null }] })] });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });

  it("replaces the waiting list each sweep, rather than accumulating across sweeps", () => {
    const waiting = new WaitingPrReport();
    const { github: first } = stubGithub({ prs: [pr({ threads: [{ resolved: false, byBot: false, author: null }] })] });
    const { github: second } = stubGithub({ prs: [pr({ threads: [] })] });

    sweepPullRequests(first, () => {}, NOW, undefined, waiting);
    sweepPullRequests(second, () => {}, NOW, undefined, waiting);

    assert.deepEqual(waiting.items(), []);
  });
});

describe("followUpPhase", () => {
  it("logs a thrown sweep through warn and doesn't throw", () => {
    const warnings: string[] = [];

    followUpPhase(
      () => {
        throw new Error("GitHub's API is unavailable");
      },
      (message) => warnings.push(message),
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /GitHub's API is unavailable/);
  });

  // #147: the early exit reads followUpPhase's result, so a failed sweep
  // must never look like it found work.
  it("returns no PRs needing a pass when the sweep throws", () => {
    const result = followUpPhase(
      () => {
        throw new Error("GitHub's API is unavailable");
      },
      () => {},
    );

    assert.deepEqual(result, { needsPass: [], passes: [] });
  });

  it("returns the sweep's result when it succeeds", () => {
    const result = followUpPhase(() => ({ needsPass: [101, 102], passes: [] }));

    assert.deepEqual(result, { needsPass: [101, 102], passes: [] });
  });
});

// #147: the early exit needs the PRs the sweep found needing a follow-up
// pass, and only those, so it doesn't start an agent for a PR the sweep
// already updated or is still waiting on. #78: the pass pipeline
// (lib/follow-up-pass.mts#followUpPassPhase) needs those same PRs as
// PassTargets, so it never has to re-read what the sweep already read.
describe("sweepPullRequests' needsPass and passes result", () => {
  it("collects the PR numbers logged as needing a follow-up pass, and only those", () => {
    const needsPassPr = pr({ number: 101, mergeStateStatus: "DIRTY" });
    const updatedPr = pr({
      number: 102,
      id: "PR_102",
      headRefName: "feature/43-add-sorting",
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "a".repeat(40) }],
    });
    const waitingPr = pr({
      number: 103,
      id: "PR_103",
      headRefName: "feature/44-add-paging",
      reviews: [],
      reviewRequests: [],
      checks: [{ name: "build", completed: false, green: false, completedAt: null }],
    });
    const { github } = stubGithub({
      prs: [needsPassPr, updatedPr, waitingPr],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
        { number: 44, labels: [] },
      ],
    });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.needsPass, [101]);
  });

  it("is empty when nothing needs a follow-up pass", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result, { needsPass: [], passes: [] });
  });

  // #78: runPass reads PassTarget.id, headRefName, headRefOid and
  // issueNumber to start a sandbox on the PR's own head, and reasons to
  // explain a give-up; the pass pipeline must never have to read the PR
  // again from GitHub just to learn them.
  it("carries a PassTarget for each PR logged as needing a follow-up pass, with the sweep's reasons", () => {
    const needsPassPr = pr({ number: 101, id: "PR_101", headRefName: BRANCH, headRefOid: "b".repeat(40), mergeStateStatus: "DIRTY" });
    const { github } = stubGithub({ prs: [needsPassPr] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.passes, [
      { number: 101, id: "PR_101", headRefName: BRANCH, headRefOid: "b".repeat(40), issueNumber: 42, reasons: ["it has merge conflicts"], conflicted: true },
    ]);
  });

  it("returns no passes when nothing needs a follow-up pass", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    const result = sweepPullRequests(github, () => {}, NOW);

    assert.deepEqual(result.passes, []);
  });
});

describe("startFromMain", () => {
  const issueNumber = 42;
  const base = "m".repeat(40);
  const closedHead = "c".repeat(40);
  // A person removed sandcastle:needs-human after the closed PR's closedAt
  // (closedPr's default), re-queueing the issue to rebuild.
  const requeued: TimelineLabelEvent[] = [{ event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-02T00:00:00Z" }];

  function stubFollowUpGithub(closed: ClosedPullRequest[], timeline: TimelineLabelEvent[] = requeued, failHandBack?: Error) {
    const handBacks: { issueNumber: number; reason: string; body: string }[] = [];
    const github: Pick<FollowUpGitHub, "hostLogin" | "closedPullRequests" | "labelTimeline" | "handBack"> = {
      hostLogin: () => HOST,
      closedPullRequests: () => closed,
      labelTimeline: () => timeline,
      handBack: (number, reason, body) => {
        handBacks.push({ issueNumber: number, reason, body });
        if (failHandBack) throw failHandBack;
      },
    };
    return { github, handBacks };
  }

  // Every ref holds the closed head and base has none of it, so a call that
  // reaches the deletes deletes all three.
  function recordingRefs() {
    const calls: string[] = [];
    const refs: BranchRefs = {
      remoteHead: (b) => {
        calls.push(`remoteHead ${b}`);
        return "r".repeat(40);
      },
      localHead: (ref) => {
        calls.push(`localHead ${ref}`);
        return "l".repeat(40);
      },
      contains: (commit, ancestor) => {
        calls.push(`contains ${commit} ${ancestor}`);
        return false;
      },
      hasCommit: () => true,
      fetchPullHead: (number) => void calls.push(`fetchPullHead ${number}`),
      mergeBase: (commit, other) => {
        calls.push(`mergeBase ${commit} ${other}`);
        return other;
      },
      deleteLocalBranch: (b) => void calls.push(`deleteLocalBranch ${b}`),
      deleteRef: (ref) => void calls.push(`deleteRef ${ref}`),
      deleteRemote: (b, sha) => void calls.push(`deleteRemote ${b} ${sha}`),
    };
    return { refs, calls };
  }

  it("returns undefined when the issue has no PR closed without merging", () => {
    const { refs } = recordingRefs();

    const result = startFromMain(issueNumber, BRANCH, base, stubFollowUpGithub([]).github, refs);

    assert.equal(result, undefined);
  });

  it("returns undefined when the closed PR's branch isn't the one being built", () => {
    const { refs } = recordingRefs();
    const { github } = stubFollowUpGithub([closedPr({ headRefName: "feature/42-another-attempt" })]);

    const result = startFromMain(issueNumber, BRANCH, base, github, refs);

    assert.equal(result, undefined);
  });

  it("discards the closed PR's work, judged against its head, once a person re-queued the issue", () => {
    const { refs, calls } = recordingRefs();
    const { github, handBacks } = stubFollowUpGithub([closedPr({ number: 99, headRefOid: closedHead })]);

    const result = startFromMain(issueNumber, BRANCH, base, github, refs);

    assert.deepEqual(result, { pr: 99, deleted: [`refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`, `origin/${BRANCH}`] });
    assert.ok(calls.includes(`contains ${base} ${closedHead}`), calls.join("\n"));
    assert.ok(calls.includes(`mergeBase ${"l".repeat(40)} ${closedHead}`), calls.join("\n"));
    assert.deepEqual(handBacks, []);
  });

  // The PR closed after this round's sweep, or the sweep's hand-back failed:
  // nobody agreed to a rebuild, so the work stays and the issue goes back.
  it("hands the issue back and stops the build, deleting nothing, when nobody re-queued it since the PR closed", () => {
    const { refs, calls } = recordingRefs();
    const { github, handBacks } = stubFollowUpGithub([closedPr({ number: 99, closedAt: "2026-10-03T00:00:00Z" })]);

    assert.throws(() => startFromMain(issueNumber, BRANCH, base, github, refs), /PR #99 was closed without merging/);
    assert.deepEqual(handBacks, [
      { issueNumber, reason: "PR #99 was closed without merging", body: closedPrHandBackComment(closedPr({ number: 99 })) },
    ]);
    assert.ok(!calls.some((call) => call.startsWith("delete")), calls.join("\n"));
  });

  it("still stops the build, deleting nothing, when that hand-back fails", () => {
    const { refs, calls } = recordingRefs();
    const { github } = stubFollowUpGithub([closedPr({ number: 99 })], [], new Error("gh: HTTP 502"));

    assert.throws(() => startFromMain(issueNumber, BRANCH, base, github, refs), /HTTP 502/);
    assert.ok(!calls.some((call) => call.startsWith("delete")), calls.join("\n"));
  });
});

// #51: the sweep labels each Sandcastle PR that never carried REVIEW_LABEL, so
// a PR whose run stopped between `gh pr create` and the label, or one already
// open when #45 merged, still gets Claude's review.
describe("sweepPullRequests' review label", () => {
  const labeled = (label: string, event: "labeled" | "unlabeled" = "labeled"): TimelineLabelEvent => ({
    event,
    label,
    createdAt: "2026-10-10T08:00:00Z",
  });
  const run = (github: FollowUpGitHub, unlabelled = new UnlabelledPrReport(), carried = new Set<number>()) => {
    sweepPullRequests(github, () => {}, NOW, new OutcomeReport(), new WaitingPrReport(), unlabelled, carried);
    return unlabelled;
  };
  // Counts the label-event reads of each PR, so a test can pin how often the
  // sweep reads one across rounds.
  const countingReads = (github: FollowUpGitHub) => {
    const reads: number[] = [];
    const read = github.labelTimeline;
    github.labelTimeline = (number) => {
      reads.push(number);
      return read(number);
    };
    return reads;
  };

  // A labeled event never leaves the timeline, so the cap's PRs, swept every
  // round without the label, are read once per run rather than once per round.
  it("reads a PR's label events once a run once it finds the PR has carried review:claude", () => {
    const { github, addedPrLabels } = stubGithub({
      prs: [pr({ labels: [] })],
      timelines: { 101: [labeled(REVIEW_LABEL), labeled(REVIEW_LABEL, "unlabeled")] },
    });
    const reads = countingReads(github);
    const carried = new Set<number>();

    run(github, new UnlabelledPrReport(), carried);
    run(github, new UnlabelledPrReport(), carried);

    assert.deepEqual(reads, [101]);
    assert.deepEqual(addedPrLabels, []);
  });

  it("reads a PR's label events again the next round when the read failed", () => {
    const { github } = stubGithub({ prs: [pr({ labels: [] })], failTimelineFor: [101] });
    const reads = countingReads(github);
    const carried = new Set<number>();

    run(github, new UnlabelledPrReport(), carried);
    run(github, new UnlabelledPrReport(), carried);

    assert.deepEqual(reads, [101, 101]);
  });

  it("adds review:claude to a host PR that has never carried it", () => {
    const { github, addedPrLabels } = stubGithub({ prs: [pr({ labels: [] })], timelines: { 101: [labeled("docs-only")] } });

    run(github);

    assert.deepEqual(addedPrLabels, [{ number: 101, label: REVIEW_LABEL }]);
  });

  it("adds review:claude to a host PR with no label history at all", () => {
    const { github, addedPrLabels } = stubGithub({ prs: [pr({ labels: [] })] });

    run(github);

    assert.deepEqual(addedPrLabels, [{ number: 101, label: REVIEW_LABEL }]);
  });

  it("leaves a host PR alone when review:claude was taken off it, so PR Auto-Merge's review cap holds", () => {
    const { github, addedPrLabels } = stubGithub({
      prs: [pr({ labels: [] })],
      timelines: { 101: [labeled(REVIEW_LABEL), labeled(REVIEW_LABEL, "unlabeled")] },
    });

    const unlabelled = run(github);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(unlabelled.items(), []);
  });

  it("matches the label in its timeline case-insensitively, as GitHub does", () => {
    const { github, addedPrLabels } = stubGithub({
      prs: [pr({ labels: [] })],
      timelines: { 101: [labeled("Review:Claude"), labeled("Review:Claude", "unlabeled")] },
    });

    run(github);

    assert.deepEqual(addedPrLabels, []);
  });

  it("leaves a host PR alone when it carries review:claude now", () => {
    const { github, addedPrLabels } = stubGithub({ prs: [pr({ labels: [REVIEW_LABEL] })] });

    run(github);

    assert.deepEqual(addedPrLabels, []);
  });

  it("doesn't read the timeline of a PR that carries review:claude now", () => {
    const { github, addedPrLabels } = stubGithub({ prs: [pr({ labels: [REVIEW_LABEL] })], failTimelineFor: [101] });

    const unlabelled = run(github);

    assert.deepEqual(addedPrLabels, []);
    assert.deepEqual(unlabelled.items(), []);
  });

  for (const [name, overrides] of [
    ["a fork's PR", { isCrossRepository: true }],
    ["a collaborator's PR", { author: "a-collaborator" }],
    ["a PR without PR_MARKER", { body: "Closes #42" }],
    ["a PR into another base", { baseRefName: "develop" }],
    ["a PR not on an issue branch", { headRefName: "chore/42-add-search" }],
  ] as [string, Partial<SweepPullRequest>][]) {
    it(`never labels ${name}`, () => {
      const { github, addedPrLabels } = stubGithub({ prs: [pr({ labels: [], ...overrides })] });

      const unlabelled = run(github);

      assert.deepEqual(addedPrLabels, []);
      assert.deepEqual(unlabelled.items(), []);
    });
  }

  it("records a PR whose label add fails in unlabelledPrReport, warns, and goes on to the next PR", () => {
    const first = pr({ number: 101, labels: [] });
    const second = pr({ number: 102, id: "PR_102", headRefName: "feature/43-add-sorting", labels: [] });
    const { github, addedPrLabels } = stubGithub({
      prs: [first, second],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
      ],
      failAddLabelFor: [101],
    });
    const lines: string[] = [];
    const unlabelled = new UnlabelledPrReport();

    sweepPullRequests(github, (line) => lines.push(line), NOW, new OutcomeReport(), new WaitingPrReport(), unlabelled);

    assert.equal(unlabelled.items().length, 1);
    assert.equal(unlabelled.items()[0]!.pr, 101);
    assert.match(unlabelled.items()[0]!.url, /101/);
    assert.deepEqual(addedPrLabels, [{ number: 102, label: REVIEW_LABEL }]);
    assert.ok(lines.some((line) => line.includes("#101") && line.includes(REVIEW_LABEL)), lines.join("\n"));
  });

  // A PR whose label PR Auto-Merge took off at the review cap is read every
  // round, so a failed read mustn't tell the owner to add the label by hand:
  // that would bypass the cap.
  it("records nothing for a PR whose timeline read fails, warns that the next round checks again, and goes on to the next PR", () => {
    const first = pr({ number: 101, labels: [] });
    const second = pr({ number: 102, id: "PR_102", headRefName: "feature/43-add-sorting", labels: [] });
    const { github, addedPrLabels } = stubGithub({
      prs: [first, second],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
      ],
      failTimelineFor: [101],
    });
    const lines: string[] = [];
    const unlabelled = new UnlabelledPrReport();

    sweepPullRequests(github, (line) => lines.push(line), NOW, new OutcomeReport(), new WaitingPrReport(), unlabelled);

    assert.deepEqual(unlabelled.items(), []);
    assert.deepEqual(addedPrLabels, [{ number: 102, label: REVIEW_LABEL }]);
    assert.ok(lines.some((line) => line.includes("#101") && /next round/.test(line) && !/by hand/.test(line)), lines.join("\n"));
  });

  it("takes a PR back out of unlabelledPrReport once a later sweep adds the label", () => {
    const unlabelled = new UnlabelledPrReport();
    const failing = stubGithub({ prs: [pr({ labels: [] })], failAddLabelFor: [101] });
    run(failing.github, unlabelled);
    const succeeding = stubGithub({ prs: [pr({ labels: [] })] });

    run(succeeding.github, unlabelled);

    assert.deepEqual(unlabelled.items(), []);
  });

  it("lists a PR once however many sweeps fail to label it", () => {
    const unlabelled = new UnlabelledPrReport();
    const { github } = stubGithub({ prs: [pr({ labels: [] })], failAddLabelFor: [101] });

    run(github, unlabelled);
    run(github, unlabelled);

    assert.deepEqual(unlabelled.items().map((entry) => entry.pr), [101]);
  });

  it("takes a PR out of unlabelledPrReport once it's no longer open, and keeps an open one the sweep skips", () => {
    const unlabelled = new UnlabelledPrReport();
    unlabelled.record({ pr: 100, url: "https://github.com/o/r/pull/100" });
    unlabelled.record({ pr: 101, url: "https://github.com/o/r/pull/101" });
    const { github } = stubGithub({ prs: [pr({ labels: [], author: "a-collaborator" })] });

    run(github, unlabelled);

    assert.deepEqual(unlabelled.items().map((entry) => entry.pr), [101]);
  });

  it("takes a PR back out of unlabelledPrReport once a later sweep finds it has carried the label", () => {
    const unlabelled = new UnlabelledPrReport();
    unlabelled.record({ pr: 101, url: "https://github.com/o/r/pull/101" });
    const { github } = stubGithub({
      prs: [pr({ labels: [] })],
      timelines: { 101: [labeled(REVIEW_LABEL), labeled(REVIEW_LABEL, "unlabeled")] },
    });

    run(github, unlabelled);

    assert.deepEqual(unlabelled.items(), []);
  });

  it("still decides the PR's follow-up after a failed label add", () => {
    const { github, updatedBranches } = stubGithub({ prs: [pr({ labels: [], mergeStateStatus: "BEHIND" })], failAddLabelFor: [101] });

    run(github);

    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
  });

  it("never throws for a failed label add or timeline read", () => {
    const { github } = stubGithub({ prs: [pr({ labels: [] })], failAddLabelFor: [101] });
    const { github: failingTimeline } = stubGithub({ prs: [pr({ labels: [] })], failTimelineFor: [101] });

    assert.doesNotThrow(() => run(github));
    assert.doesNotThrow(() => run(failingTimeline));
  });
});

// #53: a full run and a follow-up run can go at the same time, and both take
// sandcastle:building on a PR's issue before they pass on it or build it. The
// sweep leaves a PR whose issue holds the label alone, so neither run updates
// the branch, re-asks Copilot or relabels a PR the other is working on.
describe("sweepSkipReason's building guard", () => {
  it("skips a PR whose issue another run holds sandcastle:building on, naming the label", () => {
    const reason = sweepSkipReason(pr(), IN_SCOPE, HOST, new Set([42]));

    assert.ok(reason);
    assert.ok(reason.includes(BUILDING_LABEL), reason);
  });

  it("has no skip reason when only another issue is being built", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST, new Set([43])), undefined);
  });

  it("has no skip reason when no issue is being built", () => {
    assert.equal(sweepSkipReason(pr(), IN_SCOPE, HOST, new Set()), undefined);
  });
});

describe("sweepPullRequests' building guard", () => {
  const run = (github: FollowUpGitHub, lines: string[] = []) =>
    sweepPullRequests(github, (line) => lines.push(line), NOW, new OutcomeReport(), new WaitingPrReport(), new UnlabelledPrReport(), new Set<number>());

  for (const label of [BUILDING_LABEL, "Sandcastle:Building"]) {
    it(`makes no write for a PR whose issue is labelled ${label}, however far behind main or unreviewed it is`, () => {
      const { github, requestedReviews, updatedBranches, handBacks, addedPrLabels } = stubGithub({
        prs: [pr({ mergeStateStatus: "BEHIND", reviews: [], reviewRequests: [] })],
        issues: [{ number: 42, labels: [label] }],
      });

      run(github);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(requestedReviews, []);
      assert.deepEqual(handBacks, []);
      assert.deepEqual(addedPrLabels, [], "the sweep labelled a PR another run is working on");
    });

    it(`leaves a PR whose issue is labelled ${label} out of needsPass and passes`, () => {
      const { github } = stubGithub({
        prs: [pr({ mergeStateStatus: "DIRTY" })],
        issues: [{ number: 42, labels: [label] }],
      });

      const result = run(github);

      assert.deepEqual(result, { needsPass: [], passes: [] });
    });
  }

  it("logs why it skipped the PR, naming sandcastle:building", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })], issues: [{ number: 42, labels: [BUILDING_LABEL] }] });
    const lines: string[] = [];

    run(github, lines);

    assert.ok(lines.some((line) => line.includes("#101") && line.includes(BUILDING_LABEL)), lines.join("\n"));
  });

  it("doesn't add its PR to the run report's waiting list", () => {
    const { github } = stubGithub({
      prs: [pr({ threads: [{ resolved: false, byBot: false, author: "someone" }] })],
      isOwner: () => false,
      issues: [{ number: 42, labels: [BUILDING_LABEL] }],
    });
    const waiting = new WaitingPrReport();

    sweepPullRequests(github, () => {}, NOW, new OutcomeReport(), waiting, new UnlabelledPrReport(), new Set<number>());

    assert.deepEqual(waiting.items(), []);
  });

  it("still decides another PR in the same sweep whose issue isn't being built", () => {
    const held = pr({ number: 101, mergeStateStatus: "BEHIND" });
    const other = pr({
      number: 102,
      id: "PR_102",
      headRefName: "feature/43-add-sorting",
      headRefOid: "b".repeat(40),
      mergeStateStatus: "BEHIND",
      reviews: [{ author: COPILOT_REVIEWER, commitOid: "b".repeat(40) }],
      labels: [REVIEW_LABEL],
    });
    const { github, updatedBranches } = stubGithub({
      prs: [held, other],
      issues: [
        { number: 42, labels: [BUILDING_LABEL] },
        { number: 43, labels: [] },
      ],
    });

    run(github);

    assert.deepEqual(updatedBranches, [{ number: 102, expectedHeadSha: "b".repeat(40) }]);
  });

  it("sweeps a PR as usual when its issue carries no sandcastle:building", () => {
    const { github, updatedBranches } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], issues: [{ number: 42, labels: ["sandcastle:ready"] }] });

    run(github);

    assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
  });
});

// #53: a follow-up-only run touches only open PRs. The closed-without-merging
// hand-back is an issue-level step a full run does, so a full run and a
// follow-up run can't both hand back one issue and post two comments.
describe("sweepPullRequests' closed-PR hand-back switch", () => {
  const run = (github: FollowUpGitHub, handBackClosed?: boolean) =>
    sweepPullRequests(
      github,
      () => {},
      NOW,
      new OutcomeReport(),
      new WaitingPrReport(),
      new UnlabelledPrReport(),
      new Set<number>(),
      handBackClosed,
    );

  it("neither reads the closed PRs nor hands an issue back when handBackClosed is false", () => {
    const { github, handBacks, closedCalls } = stubGithub({ prs: [], closed: [closedPr()] });

    run(github, false);

    assert.deepEqual(closedCalls, []);
    assert.deepEqual(handBacks, []);
  });

  it("still sweeps the open PRs when handBackClosed is false", () => {
    const { github, updatedBranches } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], closed: [closedPr()] });

    run(github, false);

    assert.equal(updatedBranches.length, 1);
  });

  it("still returns the PRs that need a pass when handBackClosed is false", () => {
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "DIRTY" })] });

    const result = run(github, false);

    assert.deepEqual(result.needsPass, [101]);
  });

  it("hands an issue back by default, as a full run does", () => {
    const { github, handBacks, closedCalls } = stubGithub({ prs: [], closed: [closedPr()] });

    run(github);

    assert.deepEqual(closedCalls, [HOST]);
    assert.equal(handBacks.length, 1);
  });

  it("hands an issue back when handBackClosed is true", () => {
    const { github, handBacks } = stubGithub({ prs: [], closed: [closedPr()] });

    run(github, true);

    assert.equal(handBacks.length, 1);
  });
});

// #53: the sweep reads sandcastle:building once, so a claim made after that
// snapshot is caught by a fresh read right before a write, and an owner check
// that couldn't finish is reported to onPrError like any other PR failure.
describe("sweepPullRequests' re-read before a write", () => {
  const run = (github: FollowUpGitHub, onPrError: (pr: number, error: unknown) => void = () => {}, lines: string[] = []) =>
    sweepPullRequests(
      github,
      (line) => void lines.push(line),
      NOW,
      new OutcomeReport(),
      new WaitingPrReport(),
      new UnlabelledPrReport(),
      new Set<number>(),
      false,
      onPrError,
    );

  it("doesn't update a branch whose issue was claimed after the sweep began", () => {
    const lines: string[] = [];
    const { github, updatedBranches } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      labelsNow: { 42: ["Sandcastle:Building"] },
    });

    run(github, undefined, lines);

    assert.deepEqual(updatedBranches, []);
    assert.ok(lines.some((line) => /PR #101 isn't swept: .*sandcastle:building/.test(line)));
  });

  it("still updates a branch whose issue stays free", () => {
    const { github, updatedBranches } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });

    run(github);

    assert.equal(updatedBranches.length, 1);
  });

  it("doesn't ask Copilot again for a PR whose issue was claimed after the sweep began", () => {
    const lines: string[] = [];
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { github, requestedReviews } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
      labelsNow: { 42: [BUILDING_LABEL] },
    });

    run(github, undefined, lines);

    assert.deepEqual(requestedReviews, []);
    assert.ok(lines.some((line) => /PR #101 isn't swept: .*sandcastle:building/.test(line)));
  });

  it("still asks Copilot again for a PR whose issue stays free", () => {
    const completedAt = new Date(NOW - 61 * 60 * 1000).toISOString();
    const { github, requestedReviews } = stubGithub({
      prs: [pr({ reviews: [], reviewRequests: [], checks: [{ name: "build", completed: true, green: true, completedAt }] })],
    });

    run(github);

    assert.deepEqual(requestedReviews, ["PR_101"]);
  });

  it("doesn't re-read the issue's labels for a PR that needs a pass, waits or is left alone", () => {
    const { github, labelReads } = stubGithub({
      prs: [
        pr({ number: 101, mergeStateStatus: "DIRTY" }),
        pr({ number: 102, headRefName: "feature/43-other", mergeStateStatus: "CLEAN", checks: [{ name: "build", completed: false, green: false, completedAt: null }] }),
        pr({ number: 103, headRefName: "feature/44-third" }),
      ],
      issues: [
        { number: 42, labels: [] },
        { number: 43, labels: [] },
        { number: 44, labels: [] },
      ],
    });
    const outcomes: string[] = [];

    sweepPullRequests(github, (line) => void outcomes.push(line), NOW, new OutcomeReport(), new WaitingPrReport(), new UnlabelledPrReport(), new Set<number>(), false);

    assert.ok(outcomes.some((line) => line.includes("PR #101 needs a follow-up pass")), outcomes.join("\n"));
    assert.deepEqual(labelReads, []);
  });

  it("skips, without reporting a failure, a branch update GitHub refused because the head moved", () => {
    const lines: string[] = [];
    const failed: number[] = [];
    const outcomes = new OutcomeReport();
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const moved: FollowUpGitHub = {
      ...github,
      updateBranch: () => {
        throw new HeadMovedError("PR #101's head moved since the sweep read it");
      },
    };

    sweepPullRequests(moved, (line) => void lines.push(line), NOW, outcomes, new WaitingPrReport(), new UnlabelledPrReport(), new Set<number>(), false, (pr) => void failed.push(pr));

    assert.deepEqual(failed, []);
    assert.deepEqual(outcomes.items(), []);
    assert.ok(lines.some((line) => /PR #101 isn't updated: its head moved/.test(line)), lines.join("\n"));
  });

  it("still reports a branch update that failed for another reason", () => {
    const failed: number[] = [];
    const { github } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })] });
    const broken: FollowUpGitHub = {
      ...github,
      updateBranch: () => {
        throw new Error("gh api failed: HTTP 502");
      },
    };

    sweepPullRequests(broken, () => {}, NOW, new OutcomeReport(), new WaitingPrReport(), new UnlabelledPrReport(), new Set<number>(), false, (pr) => void failed.push(pr));

    assert.deepEqual(failed, [101]);
  });

  it("reports a PR whose owner check couldn't finish to onPrError", () => {
    const failed: number[] = [];
    const { github, updatedBranches } = stubGithub({
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      isOwner: () => undefined,
      pullRequestEvents: () => [
        { event: "unlabeled", actor: "ghost", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
      ],
    });

    run(github, (number) => void failed.push(number));

    assert.deepEqual(failed, [101]);
    assert.deepEqual(updatedBranches, []);
  });
});

// ---------------------------------------------------------------------------
// #58: hand-off PRs. A same-repo PR into main that carries sandcastle:follow-up
// is followed up like one of Sandcastle's own, without PR_MARKER, an issue
// branch or an in-scope issue.
// ---------------------------------------------------------------------------

const OWNER = "the-owner";

// A hand-opened chore PR: no marker, not the host's, no issue, labelled for
// follow-up and already labelled review:claude, so the sweep adds no label.
function handOff(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return pr({
    author: OWNER,
    body: "Tidies the docs.",
    headRefName: "chore/tidy-docs",
    labels: [FOLLOW_UP_LABEL, REVIEW_LABEL],
    ...overrides,
  });
}

// The owner's add of sandcastle:follow-up, then whatever `more` happened.
const ownerAdd: IssueEvent = { event: "labeled", actor: OWNER, label: FOLLOW_UP_LABEL, createdAt: "2026-10-09T00:00:00Z" };
const isOwnerOrStranger = (login: string | null) => (login === null ? false : login === OWNER || login === HOST ? true : login === "ghost" ? undefined : false);

describe("sweepSkipReason's hand-offs", () => {
  it("has no skip reason for a labelled chore PR with no marker, no issue branch and another author", () => {
    assert.equal(sweepSkipReason(handOff(), IN_SCOPE, HOST, new Set(), true), undefined);
  });

  it("has no skip reason for a labelled PR on an issue branch whose issue isn't in scope", () => {
    const labelled = handOff({ headRefName: "feature/9-other-thing" });

    assert.equal(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set(), true), undefined);
  });

  it("matches the label case-insensitively, as GitHub does", () => {
    const labelled = handOff({ labels: ["Sandcastle:Follow-Up"] });

    assert.equal(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set(), true), undefined);
  });

  it("keeps today's reason for a chore PR when the run doesn't follow hand-offs", () => {
    assert.match(sweepSkipReason(handOff(), IN_SCOPE, HOST, new Set(), false) ?? "", /chore\/tidy-docs isn't an issue branch/);
    assert.match(sweepSkipReason(handOff(), IN_SCOPE, HOST) ?? "", /chore\/tidy-docs isn't an issue branch/);
  });

  it("keeps today's reason for an out-of-scope issue branch when the run doesn't follow hand-offs", () => {
    const labelled = handOff({ headRefName: "feature/9-other-thing" });

    assert.match(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set(), false) ?? "", /#9 isn't an open Sandcastle issue/);
  });

  it("keeps today's reasons for a chore PR without the label, even when the run follows hand-offs", () => {
    const unlabelled = handOff({ labels: [REVIEW_LABEL] });

    assert.match(sweepSkipReason(unlabelled, IN_SCOPE, HOST, new Set(), true) ?? "", /chore\/tidy-docs isn't an issue branch/);
  });

  // The branch name reaches a shell in the sandbox, and dev, preview and
  // dependabot/* are not branches a person hands off.
  for (const branch of ["chore/9-x", "dev", "preview", "dependabot/npm_and_yarn/x", "chore/$(touch-x)", "docs/release-notes"]) {
    it(`skips a labelled PR from ${branch}, which scripts/check-branch-name.sh doesn't accept`, () => {
      const labelled = handOff({ headRefName: branch });

      assert.match(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set(), true) ?? "", /isn't an issue branch/);
    });
  }

  it("skips a labelled PR from a fork, first", () => {
    assert.match(sweepSkipReason(handOff({ isCrossRepository: true }), IN_SCOPE, HOST, new Set(), true) ?? "", /fork/);
  });

  it("skips a labelled PR into another base, first", () => {
    assert.match(sweepSkipReason(handOff({ baseRefName: "dev" }), IN_SCOPE, HOST, new Set(), true) ?? "", /into dev, not main/);
  });

  it("skips a labelled PR that is itself labelled sandcastle:building, because another run is passing on it", () => {
    const claimed = handOff({ labels: [FOLLOW_UP_LABEL, BUILDING_LABEL] });

    assert.match(sweepSkipReason(claimed, IN_SCOPE, HOST, new Set(), true) ?? "", /labelled sandcastle:building/);
  });

  it("skips a labelled PR on the branch of an issue that is labelled sandcastle:building, since a build there shares the branch", () => {
    const labelled = handOff({ headRefName: "feature/42-add-search", author: "someone-else", body: "no marker" });

    assert.match(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set([42]), true) ?? "", /#42 is labelled sandcastle:building/);
  });

  it("skips a labelled PR whose issue branch is under a build even when the PR itself isn't labelled", () => {
    const labelled = handOff({ headRefName: "fix/9-other-thing" });

    assert.match(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set([9]), true) ?? "", /#9 is labelled sandcastle:building/);
  });

  it("skips a labelled draft PR", () => {
    assert.equal(sweepSkipReason(handOff({ isDraft: true }), IN_SCOPE, HOST, new Set(), true), "it's a draft");
  });

  it("skips a labelled PR that is labelled sandcastle:needs-human", () => {
    const handedBack = handOff({ labels: [FOLLOW_UP_LABEL, "sandcastle:needs-human"] });

    assert.match(sweepSkipReason(handedBack, IN_SCOPE, HOST, new Set(), true) ?? "", /sandcastle:needs-human/);
  });

  it("skips a labelled PR with more reviews, threads or checks than one read holds", () => {
    assert.match(sweepSkipReason(handOff({ truncated: true }), IN_SCOPE, HOST, new Set(), true) ?? "", /more reviews, threads or checks/);
  });

  // A Sandcastle PR stays a Sandcastle PR: the label doesn't change which
  // issue's claim it is held under.
  it("still holds a labelled Sandcastle PR back for its issue's building claim", () => {
    const labelled = pr({ labels: [FOLLOW_UP_LABEL] });

    assert.match(sweepSkipReason(labelled, IN_SCOPE, HOST, new Set([42]), true) ?? "", /#42 is labelled sandcastle:building/);
  });
});

describe("sweepSubject", () => {
  it("is the issue for a Sandcastle PR of an in-scope issue, even when it also carries the label", () => {
    const labelled = pr({ labels: [FOLLOW_UP_LABEL] });

    assert.deepEqual(sweepSubject(labelled, IN_SCOPE, HOST, true), { kind: "issue", issueNumber: 42 });
  });

  it("is the issue for a Sandcastle PR of an in-scope issue without the label", () => {
    assert.deepEqual(sweepSubject(pr(), IN_SCOPE, HOST, true), { kind: "issue", issueNumber: 42 });
  });

  it("is the PR for a Sandcastle PR of an issue out of scope that carries the label, whose issue text the owner never approved", () => {
    const labelled = pr({ labels: [FOLLOW_UP_LABEL], headRefName: "feature/9-other-thing" });

    assert.deepEqual(sweepSubject(labelled, IN_SCOPE, HOST, true), { kind: "pull-request" });
  });

  it("is the PR for a labelled chore PR", () => {
    assert.deepEqual(sweepSubject(handOff(), IN_SCOPE, HOST, true), { kind: "pull-request" });
  });

  it("is the PR for a labelled PR on an issue branch with no marker and another author", () => {
    const labelled = handOff({ headRefName: "feature/42-add-search" });

    assert.deepEqual(sweepSubject(labelled, IN_SCOPE, HOST, true), { kind: "pull-request" });
  });

  it("is undefined for an unlabelled PR that isn't a Sandcastle PR", () => {
    assert.equal(sweepSubject(handOff({ labels: [] }), IN_SCOPE, HOST, true), undefined);
  });

  it("is undefined for a labelled PR when the run doesn't follow hand-offs", () => {
    assert.equal(sweepSubject(handOff(), IN_SCOPE, HOST, false), undefined);
  });

  it("is still the issue for a Sandcastle PR when the run doesn't follow hand-offs", () => {
    assert.deepEqual(sweepSubject(pr(), IN_SCOPE, HOST, false), { kind: "issue", issueNumber: 42 });
  });

  it("is undefined for a labelled PR from a branch scripts/check-branch-name.sh doesn't accept", () => {
    assert.equal(sweepSubject(handOff({ headRefName: "dev" }), IN_SCOPE, HOST, true), undefined);
  });

  it("matches the label case-insensitively", () => {
    assert.deepEqual(sweepSubject(handOff({ labels: ["SANDCASTLE:FOLLOW-UP"] }), IN_SCOPE, HOST, true), { kind: "pull-request" });
  });
});

describe("followsHandOffs", () => {
  it("is true for the default Sandcastle label scope, which Actions always uses", () => {
    assert.equal(followsHandOffs({ kind: "label", label: "Sandcastle" }), true);
  });

  it("is false for a local run working another label", () => {
    assert.equal(followsHandOffs({ kind: "label", label: "Sandcastle:dev" }), false);
  });

  it("is false for a local run building one issue", () => {
    assert.equal(followsHandOffs({ kind: "issue", number: 42 }), false);
  });
});

describe("sweepPullRequests' hand-offs", () => {
  const run = (github: FollowUpGitHub, onPrError: (pr: number, error: unknown) => void = () => {}, lines: string[] = []) =>
    sweepPullRequests(
      github,
      (line) => void lines.push(line),
      NOW,
      new OutcomeReport(),
      new WaitingPrReport(),
      new UnlabelledPrReport(),
      new Set<number>(),
      false,
      onPrError,
    );
  const staleCompletedAt = new Date(NOW - 61 * 60 * 1000).toISOString();

  describe("acts on a PR the owner labelled", () => {
    it("updates a settled hand-off PR that is only behind main", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
    });

    it("updates a behind hand-off PR whose only open bot thread the host already answered", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [
          handOff({
            mergeStateStatus: "BEHIND",
            threads: [
              {
                resolved: false,
                byBot: true,
                author: "copilot-pull-request-reviewer",
                recentComments: [{ author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` }],
              },
            ],
          }),
        ],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(updatedBranches, [{ number: 101, expectedHeadSha: "a".repeat(40) }]);
    });

    it("asks Copilot again to review a hand-off PR whose CI has been done for over an hour with no review", () => {
      const { github, requestedReviews } = stubGithub({
        prs: [handOff({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt: staleCompletedAt }] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(requestedReviews, ["PR_101"]);
    });

    it("flags a hand-off PR with merge conflicts for a pass, with no issue number", () => {
      const { github } = stubGithub({
        prs: [handOff({ mergeStateStatus: "DIRTY" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      const result = run(github);

      assert.deepEqual(result.needsPass, [101]);
      assert.equal(result.passes.length, 1);
      assert.equal(result.passes[0]!.number, 101);
      assert.equal(result.passes[0]!.issueNumber, undefined);
      assert.equal(result.passes[0]!.conflicted, true);
      assert.equal(result.passes[0]!.headRefName, "chore/tidy-docs");
    });

    it("flags a hand-off PR with a red check for a pass", () => {
      const { github } = stubGithub({
        prs: [handOff({ checks: [{ name: "build", completed: true, green: false, completedAt: staleCompletedAt }] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      const result = run(github);

      assert.deepEqual(result.needsPass, [101]);
      assert.deepEqual(result.passes[0]!.reasons, ["check build is red"]);
    });

    it("flags a hand-off PR with an unresolved bot thread for a pass", () => {
      const { github } = stubGithub({
        prs: [handOff({ threads: [{ resolved: false, byBot: true, author: "copilot-pull-request-reviewer" }] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      assert.deepEqual(run(github).needsPass, [101]);
    });

    it("flags a hand-off PR on an out-of-scope issue branch for a pass with no issue number, not the issue's", () => {
      const { github } = stubGithub({
        prs: [handOff({ headRefName: "feature/9-other-thing", mergeStateStatus: "DIRTY" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      const result = run(github);

      assert.equal(result.passes[0]!.issueNumber, undefined);
    });

    it("leaves a settled, clean hand-off PR alone", () => {
      const lines: string[] = [];
      const { github, updatedBranches, requestedReviews } = stubGithub({
        prs: [handOff()],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      const result = run(github, undefined, lines);

      assert.ok(lines.some((line) => /PR #101 is left alone/.test(line)), lines.join("\n"));

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(requestedReviews, []);
      assert.deepEqual(result, { needsPass: [], passes: [] });
    });

    it("gives a hand-off PR that never carried review:claude the label, like any swept PR", () => {
      const { github, addedPrLabels } = stubGithub({
        prs: [handOff({ labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(addedPrLabels, [{ number: 101, label: REVIEW_LABEL }]);
    });

    it("reads the PR's events once, for the approval and the needs-human origin check together", () => {
      let reads = 0;
      const { github } = stubGithub({
        prs: [handOff()],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => {
          reads++;
          return [ownerAdd];
        },
      });

      run(github);

      assert.equal(reads, 1);
    });

    it("reads the PR's body edits for the approval", () => {
      const reads: number[] = [];
      const { github } = stubGithub({
        prs: [handOff()],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        pullRequestBodyEdits: (number) => {
          reads.push(number);
          return [];
        },
      });

      run(github);

      assert.deepEqual(reads, [101]);
    });

    it("sweeps a hand-off PR whose body the owner edited after adding the label", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        pullRequestBodyEdits: () => [{ editor: OWNER, editedAt: "2026-10-09T01:00:00Z" }],
      });

      run(github);

      assert.equal(updatedBranches.length, 1);
    });

    it("does not read an approval for a Sandcastle PR, even one that also carries the label", () => {
      const reads: number[] = [];
      const { github, updatedBranches } = stubGithub({
        prs: [pr({ labels: [FOLLOW_UP_LABEL, REVIEW_LABEL], mergeStateStatus: "BEHIND" })],
        pullRequestBodyEdits: (number) => {
          reads.push(number);
          return [];
        },
      });

      run(github);

      assert.deepEqual(reads, []);
      assert.equal(updatedBranches.length, 1);
    });

    it("gives a Sandcastle PR of an in-scope issue that carries the label an issue pass target", () => {
      const { github } = stubGithub({ prs: [pr({ labels: [FOLLOW_UP_LABEL, REVIEW_LABEL], mergeStateStatus: "DIRTY" })] });

      const result = run(github);

      assert.equal(result.passes[0]!.issueNumber, 42);
    });
  });

  describe("only the owner's label counts", () => {
    it("doesn't sweep a PR whose label a stranger added, and writes nothing", () => {
      const lines: string[] = [];
      const failed: number[] = [];
      const { github, updatedBranches, requestedReviews, addedPrLabels, handBacks } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND", labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [{ ...ownerAdd, actor: "stranger" }],
      });

      const result = run(github, (number) => void failed.push(number), lines);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(requestedReviews, []);
      assert.deepEqual(addedPrLabels, []);
      assert.deepEqual(handBacks, []);
      assert.deepEqual(result, { needsPass: [], passes: [] });
      assert.deepEqual(failed, []);
      assert.ok(lines.some((line) => /PR #101 isn't swept: .*stranger/.test(line)), lines.join("\n"));
    });

    it("doesn't sweep a PR with no event showing who added the label", () => {
      const lines: string[] = [];
      const { github, updatedBranches, addedPrLabels } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND", labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [],
      });

      run(github, undefined, lines);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(addedPrLabels, []);
      assert.ok(lines.some((line) => /PR #101 isn't swept/.test(line)));
    });

    it("doesn't sweep a PR whose body a stranger edited after the owner added the label", () => {
      const failed: number[] = [];
      const { github, updatedBranches, addedPrLabels } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND", labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        pullRequestBodyEdits: () => [{ editor: "stranger", editedAt: "2026-10-09T01:00:00Z" }],
      });

      run(github, (number) => void failed.push(number));

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(addedPrLabels, []);
      assert.deepEqual(failed, []);
    });

    it("doesn't sweep a PR a stranger renamed after the owner added the label", () => {
      const { github, updatedBranches, requestedReviews, addedPrLabels } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND", labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd, { event: "renamed", actor: "stranger", label: null, createdAt: "2026-10-09T01:00:00Z" }],
      });

      run(github);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(requestedReviews, []);
      assert.deepEqual(addedPrLabels, []);
    });

    it("sweeps a PR again once the owner removed and re-added the label after a stranger's edit", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd, { ...ownerAdd, createdAt: "2026-10-09T03:00:00Z" }],
        pullRequestBodyEdits: () => [{ editor: "stranger", editedAt: "2026-10-09T01:00:00Z" }],
      });

      run(github);

      assert.equal(updatedBranches.length, 1);
    });

    it("reports a PR whose label's origin couldn't be checked to onPrError, and writes nothing", () => {
      const failed: { pr: number; error: unknown }[] = [];
      const { github, updatedBranches, addedPrLabels } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND", labels: [FOLLOW_UP_LABEL] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [{ ...ownerAdd, actor: "ghost" }],
      });

      run(github, (number, error) => void failed.push({ pr: number, error }));

      assert.deepEqual(failed.map((entry) => entry.pr), [101]);
      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(addedPrLabels, []);
    });

    it("reports a PR to onPrError when its body edits can't be read, and writes nothing", () => {
      const failed: number[] = [];
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        pullRequestBodyEdits: () => {
          throw new Error("gh api failed: HTTP 502");
        },
      });

      run(github, (number) => void failed.push(number));

      assert.deepEqual(failed, [101]);
      assert.deepEqual(updatedBranches, []);
    });

    it("carries on to the next PR after one that isn't approved", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [
          handOff({ number: 101, mergeStateStatus: "BEHIND" }),
          handOff({ number: 102, headRefName: "chore/other-tidy", mergeStateStatus: "BEHIND" }),
        ],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: (number) => [{ ...ownerAdd, actor: number === 101 ? "stranger" : OWNER }],
      });

      run(github);

      assert.deepEqual(updatedBranches.map((branch) => branch.number), [102]);
    });
  });

  describe("scope", () => {
    it("doesn't sweep a labelled PR when the run doesn't follow hand-offs", () => {
      const lines: string[] = [];
      const { github, updatedBranches, addedPrLabels } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        followsHandOffs: false,
      });

      const result = run(github, undefined, lines);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(addedPrLabels, []);
      assert.deepEqual(result, { needsPass: [], passes: [] });
      assert.ok(lines.some((line) => /PR #101 isn't swept: .*isn't an issue branch/.test(line)));
    });

    it("never reads a labelled PR's events or edits when the run doesn't follow hand-offs", () => {
      let reads = 0;
      const { github } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        pullRequestEvents: () => {
          reads++;
          return [ownerAdd];
        },
        pullRequestBodyEdits: () => {
          reads++;
          return [];
        },
        followsHandOffs: false,
      });

      run(github);

      assert.equal(reads, 0);
    });

    it("still sweeps a Sandcastle PR when the run doesn't follow hand-offs", () => {
      const { github, updatedBranches } = stubGithub({ prs: [pr({ mergeStateStatus: "BEHIND" })], followsHandOffs: false });

      run(github);

      assert.equal(updatedBranches.length, 1);
    });

    it("doesn't sweep an unlabelled chore PR, with or without hand-offs", () => {
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ labels: [REVIEW_LABEL], mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(updatedBranches, []);
    });
  });

  describe("re-reads the PR's own labels before a write", () => {
    it("doesn't update a hand-off PR's branch when the PR became labelled sandcastle:building since the sweep began", () => {
      const lines: string[] = [];
      const { github, updatedBranches, prLabelReads, labelReads } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        prLabelsNow: { 101: [FOLLOW_UP_LABEL, BUILDING_LABEL] },
      });

      run(github, undefined, lines);

      assert.deepEqual(updatedBranches, []);
      assert.deepEqual(prLabelReads, [101]);
      assert.deepEqual(labelReads, []);
      assert.ok(lines.some((line) => /PR #101 isn't swept: .*sandcastle:building/.test(line)));
    });

    it("doesn't ask Copilot again for a hand-off PR that became labelled sandcastle:building", () => {
      const { github, requestedReviews } = stubGithub({
        prs: [handOff({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt: staleCompletedAt }] })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        prLabelsNow: { 101: [FOLLOW_UP_LABEL, "Sandcastle:Building"] },
      });

      run(github);

      assert.deepEqual(requestedReviews, []);
    });

    it("reads the PR's labels and its branch's issue's for a hand-off PR on an out-of-scope issue branch", () => {
      const { github, updatedBranches, prLabelReads, labelReads } = stubGithub({
        prs: [handOff({ headRefName: "feature/9-other-thing", mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.equal(updatedBranches.length, 1);
      // gh issue view refuses a PR's number, and the branch's number may be one.
      assert.deepEqual(prLabelReads, [101, 9]);
      assert.deepEqual(labelReads, []);
    });

    it("doesn't update a hand-off PR's branch when a build of its branch's issue claimed the issue since the sweep began", () => {
      const lines: string[] = [];
      const { github, updatedBranches } = stubGithub({
        prs: [handOff({ headRefName: "feature/9-other-thing", mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
        prLabelsNow: { 9: [BUILDING_LABEL] },
      });

      run(github, undefined, lines);

      assert.deepEqual(updatedBranches, []);
      assert.ok(lines.some((line) => /PR #101 isn't swept: .*its branch's issue became labelled sandcastle:building/.test(line)));
    });

    it("still reads the issue's labels for a Sandcastle PR, even one that carries the label", () => {
      const { github, prLabelReads, labelReads } = stubGithub({
        prs: [pr({ labels: [FOLLOW_UP_LABEL, REVIEW_LABEL], mergeStateStatus: "BEHIND" })],
      });

      run(github);

      assert.deepEqual(labelReads, [42]);
      assert.deepEqual(prLabelReads, []);
    });

    it("doesn't re-read for a hand-off PR that needs a pass, waits or is left alone", () => {
      const { github, prLabelReads } = stubGithub({
        prs: [
          handOff({ number: 101, mergeStateStatus: "DIRTY" }),
          handOff({ number: 102, headRefName: "chore/two", checks: [{ name: "build", completed: false, green: false, completedAt: null }] }),
          handOff({ number: 103, headRefName: "chore/three" }),
        ],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [ownerAdd],
      });

      run(github);

      assert.deepEqual(prLabelReads, []);
    });
  });

  describe("the needs-human origin check applies to a hand-off PR's hand-back", () => {
    it("puts back a needs-human a stranger removed from a hand-off PR, and sweeps nothing else", () => {
      const { github, addedPrLabels, updatedBranches } = stubGithub({
        prs: [handOff({ mergeStateStatus: "BEHIND" })],
        isOwner: isOwnerOrStranger,
        pullRequestEvents: () => [
          ownerAdd,
          { event: "labeled", actor: HOST, label: "sandcastle:needs-human", createdAt: "2026-10-09T01:00:00Z" },
          { event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-09T02:00:00Z" },
        ],
      });

      run(github);

      assert.deepEqual(addedPrLabels, [{ number: 101, label: "sandcastle:needs-human" }]);
      assert.deepEqual(updatedBranches, []);
    });
  });

  // A hand-off PR has no issue to re-queue: the owner closed it, so the hand-back of a
  // Sandcastle PR that closed without merging never applies.
  describe("a closed hand-off PR", () => {
    // A full run, which hands back closed PRs (handBackClosed true).
    const fullRun = (github: FollowUpGitHub) =>
      sweepPullRequests(github, () => {}, NOW, new OutcomeReport(), new WaitingPrReport(), new UnlabelledPrReport(), new Set<number>(), true);

    it("hands the issue back for a closed Sandcastle PR, as the control for the tests below", () => {
      const { github, handBacks } = stubGithub({ prs: [], closed: [closedPr({ number: 10 })] });

      fullRun(github);

      assert.equal(handBacks.length, 1);
    });

    it("hands back no issue for a closed chore PR", () => {
      const { github, handBacks } = stubGithub({
        prs: [],
        closed: [closedPr({ number: 10, author: OWNER, body: "Tidies the docs.", headRefName: "chore/tidy-docs" })],
      });

      fullRun(github);

      assert.deepEqual(handBacks, []);
    });

    it("hands back no issue for a closed PR on the issue's branch that has no PR_MARKER, whoever opened it", () => {
      const { github, handBacks } = stubGithub({
        prs: [],
        closed: [closedPr({ number: 10, author: OWNER, body: "Tidies the docs.", headRefName: "feature/42-add-search" })],
      });

      fullRun(github);

      assert.deepEqual(handBacks, []);
    });

    it("ignores a closed hand-off PR in closedWithoutMerging", () => {
      const prs = [closedPr({ number: 10, author: OWNER, body: "Tidies the docs.", headRefName: "feature/42-add-search" })];

      assert.equal(closedWithoutMerging(prs, 42, HOST), undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// #65: the status command calls the sweep's own admission checks, taken out of
// sweepPullRequests, so it can't disagree with what the sweep does.
// ---------------------------------------------------------------------------

describe("sweepContext", () => {
  it("reads the host's login, the in-scope issues and whether the run follows hand-offs, in that order", () => {
    const reads: string[] = [];

    sweepContext({
      hostLogin: () => (reads.push("hostLogin"), HOST),
      inScopeIssues: () => (reads.push("inScopeIssues"), []),
      followsHandOffs: () => (reads.push("followsHandOffs"), true),
    });

    assert.deepEqual(reads, ["hostLogin", "inScopeIssues", "followsHandOffs"]);
  });

  it("computes the in-scope numbers and the issues labelled sandcastle:building", () => {
    const issues = [
      { number: 42, labels: [] },
      { number: 43, labels: [BUILDING_LABEL] },
      { number: 44, labels: ["Sandcastle:Building"] },
    ];

    const context = sweepContext({ hostLogin: () => HOST, inScopeIssues: () => issues, followsHandOffs: () => false });

    assert.equal(context.host, HOST);
    assert.deepEqual(context.issues, issues);
    assert.deepEqual([...context.inScope].sort(), [42, 43, 44]);
    assert.deepEqual([...context.building].sort(), [43, 44]);
    assert.equal(context.handOffs, false);
  });
});

describe("admitToSweep", () => {
  const context: SweepContext = {
    host: HOST,
    issues: [{ number: 42, labels: [] }],
    inScope: IN_SCOPE,
    building: new Set(),
    handOffs: true,
  };

  // A host that records which reads were made.
  function reads(events: IssueEvent[] = [], isOwner: (login: string | null) => boolean | undefined = isOwnerOrStranger) {
    const calls: string[] = [];
    const github = {
      isOwner,
      pullRequestEvents: (number: number) => (calls.push(`events:${number}`), events),
      pullRequestBodyEdits: (number: number) => (calls.push(`edits:${number}`), [] as ContentEdit[]),
    };
    return { github, calls };
  }

  it("passes sweepSkipReason's reason through as a skip that isn't unknown, and reads no events", () => {
    const draft = pr({ isDraft: true });
    const { github, calls } = reads();

    const admission = admitToSweep(draft, context, github);

    assert.deepEqual(admission, { kind: "skipped", reason: sweepSkipReason(draft, IN_SCOPE, HOST, new Set(), true), unknown: false });
    assert.deepEqual(calls, []);
  });

  it("admits a Sandcastle PR of an in-scope issue with its issue as the subject, reading its events once and no body edits", () => {
    const { github, calls } = reads();

    const admission = admitToSweep(pr(), context, github);

    assert.deepEqual(admission, { kind: "swept", subject: { kind: "issue", issueNumber: 42 } });
    assert.deepEqual(calls, ["events:101"]);
  });

  it("admits a hand-off PR the owner labelled with the PR as the subject, reading its events once and its body edits once", () => {
    const { github, calls } = reads([ownerAdd]);

    const admission = admitToSweep(handOff(), context, github);

    assert.deepEqual(admission, { kind: "swept", subject: { kind: "pull-request" } });
    assert.deepEqual(calls.sort(), ["edits:101", "events:101"]);
  });

  it("skips a hand-off PR whose label a stranger added, with approval's reason and not unknown", () => {
    const events: IssueEvent[] = [{ ...ownerAdd, actor: "stranger" }];
    const { github } = reads(events);

    const admission = admitToSweep(handOff(), context, github);

    const expected = approval(FOLLOW_UP_LABEL, events, [], isOwnerOrStranger);
    assert.equal(expected.approved, false);
    assert.deepEqual(admission, { kind: "skipped", reason: expected.approved ? "" : expected.reason, unknown: false });
  });

  it("skips a hand-off PR whose label's adder couldn't be checked, as unknown", () => {
    const { github } = reads([{ ...ownerAdd, actor: "ghost" }]);

    const admission = admitToSweep(handOff(), context, github);

    assert.equal(admission.kind, "skipped");
    assert.equal(admission.kind === "skipped" && admission.unknown, true);
  });

  it("skips a PR whose needs-human removal couldn't be attributed, as unknown", () => {
    const { github } = reads([
      { event: "unlabeled", actor: "ghost", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ]);

    const admission = admitToSweep(pr(), context, github);

    assert.deepEqual(admission, {
      kind: "skipped",
      reason: "couldn't check whether the repository owner removed sandcastle:needs-human",
      unknown: true,
    });
  });

  it("answers restore for a PR whose needs-human a stranger removed", () => {
    const { github } = reads([
      { event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ]);

    const admission = admitToSweep(pr(), context, github);

    assert.equal(admission.kind, "restore");
    assert.equal(admission.kind === "restore" && admission.label, "sandcastle:needs-human");
    assert.match(admission.kind === "restore" ? admission.reason : "", /stranger/);
  });

  it("admits a PR whose needs-human the owner removed", () => {
    const { github } = reads([
      { event: "unlabeled", actor: OWNER, label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" },
    ]);

    const admission = admitToSweep(pr(), context, github);

    assert.equal(admission.kind, "swept");
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  COPILOT_REVIEWER,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_MARKER,
  FOLLOW_UP_PASS_CAP,
  FOLLOW_UP_REPLY_MARKER,
  GIVE_UP_MARKER,
  PR_MARKER,
  REVIEW_LABEL,
} from "./config.mts";
import { decide, sweepSkipReason, type FollowUpGitHub, type SweepPullRequest } from "./follow-up.mts";
import type { CommentReads, ContentEdit, IssueEvent, TimelineLabelEvent, WorkflowRun } from "./github.mts";
import { approval, loadQueue, type IsOwner, type QueueGitHub } from "./queue.mts";
import {
  buildStatus,
  checkSummary,
  followUpPassesUsed,
  heldReason,
  renderStatus,
  statusCommand,
  threadCounts,
  readInScopeIssues,
  withoutLabelWrites,
  type PullRequestStatus,
  type StatusGitHub,
} from "./status.mts";

const HOST = "sandcastle-bot";
const OWNER = "the-owner";
const BOT = "copilot-pull-request-reviewer[bot]";
const BRANCH = "feature/42-add-search";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const IN_SCOPE = new Set([42]);
const RECENT = new Date(NOW - 60 * 1000).toISOString();
const STALE = new Date(NOW - 61 * 60 * 1000).toISOString();

// The owner and the host are the owner; "ghost" can't be checked; anyone else isn't.
const isOwner: IsOwner = (login) => (login === null ? false : login === OWNER || login === HOST ? true : login === "ghost" ? undefined : false);

// A settled, CLEAN Sandcastle PR on issue #42's branch, reviewed by Copilot
// with every check green; tests override just what their scenario needs.
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
    id: `PR_${number}`,
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

// A hand-opened chore PR the owner labelled sandcastle:follow-up.
function handOff(overrides: Partial<SweepPullRequest> = {}): SweepPullRequest {
  return pr({
    number: 102,
    author: OWNER,
    body: "Tidies the docs.",
    headRefName: "chore/tidy-docs",
    labels: [FOLLOW_UP_LABEL, REVIEW_LABEL],
    ...overrides,
  });
}

const ownerAdd: IssueEvent = { event: "labeled", actor: OWNER, label: FOLLOW_UP_LABEL, createdAt: "2026-10-09T00:00:00Z" };
const unlabelledHandOff = (overrides: Partial<SweepPullRequest> = {}) =>
  pr({ number: 103, author: "someone", body: "A fix.", headRefName: "feature/90-other", ...overrides });

const thread = (author: string | null, extra: Partial<SweepPullRequest["threads"][number]> = {}): SweepPullRequest["threads"][number] => ({
  resolved: false,
  byBot: false,
  author,
  recentComments: [],
  ...extra,
});
const botThread = (extra: Partial<SweepPullRequest["threads"][number]> = {}) => thread(BOT, { byBot: true, ...extra });

const markerComment = (createdAt: string, author: string = HOST, marker: string = FOLLOW_UP_MARKER) => ({
  body: `${marker}\nPass summary`,
  createdAt,
  author,
});
const reads = (comments: CommentReads["comments"] = [], timeline: TimelineLabelEvent[] = [], createdAt = "2026-10-01T00:00:00Z"): CommentReads => ({
  comments,
  timeline,
  createdAt,
});
const passesUsed = (count: number): CommentReads =>
  reads(Array.from({ length: count }, (_, index) => markerComment(`2026-10-0${index + 2}T00:00:00Z`)));

const WRITES = ["requestCopilotReview", "updateBranch", "handBack", "addPullRequestLabel"];
const stubs: { calls: string[] }[] = [];

// A host that serves reads and records every call by name. The writes throw,
// so a status that wrote anything fails its test, and afterEach checks again.
function stub({
  prs = [pr()],
  issues = [{ number: 42, labels: [] }],
  events = {},
  edits = {},
  comments = {},
  runs = [],
  follows = true,
  failPassComments = [],
  failEvents = [],
  failRuns = false,
  failOpen = false,
  unchecked = [],
}: {
  prs?: SweepPullRequest[];
  issues?: { number: number; labels: string[] }[];
  events?: Record<number, IssueEvent[]>;
  edits?: Record<number, ContentEdit[]>;
  comments?: Record<number, CommentReads>;
  runs?: WorkflowRun[];
  follows?: boolean;
  failPassComments?: number[];
  failEvents?: number[];
  failRuns?: boolean;
  failOpen?: boolean;
  unchecked?: string[];
} = {}) {
  const record = { calls: [] as string[] };
  stubs.push(record);
  const write = (name: string) => () => {
    record.calls.push(name);
    throw new Error(`the status must not call ${name}`);
  };
  const github: FollowUpGitHub & StatusGitHub = {
    hostLogin: () => (record.calls.push("hostLogin"), HOST),
    openPullRequests: () => {
      record.calls.push("openPullRequests");
      if (failOpen) throw new Error("gh api graphql failed: HTTP 502");
      return prs;
    },
    closedPullRequests: () => (record.calls.push("closedPullRequests"), []),
    inScopeIssues: () => (record.calls.push("inScopeIssues"), issues),
    issueLabels: () => (record.calls.push("issueLabels"), []),
    labelTimeline: () => (record.calls.push("labelTimeline"), []),
    requestCopilotReview: write("requestCopilotReview"),
    updateBranch: write("updateBranch"),
    handBack: write("handBack"),
    isOwner,
    pullRequestEvents: (number) => {
      record.calls.push(`pullRequestEvents:${number}`);
      if (failEvents.includes(number)) throw new Error("gh api failed: HTTP 502");
      return events[number] ?? (number === 102 ? [ownerAdd] : []);
    },
    addPullRequestLabel: write("addPullRequestLabel"),
    followsHandOffs: () => (record.calls.push("followsHandOffs"), follows),
    pullRequestLabels: () => (record.calls.push("pullRequestLabels"), []),
    pullRequestBodyEdits: (number) => (record.calls.push(`pullRequestBodyEdits:${number}`), edits[number] ?? []),
    passComments: (number) => {
      record.calls.push(`passComments:${number}`);
      if (failPassComments.includes(number)) throw new Error("gh api failed: HTTP 500");
      return comments[number] ?? reads();
    },
    uncheckedIssues: () => unchecked,
    workflowRuns: () => {
      record.calls.push("workflowRuns");
      if (failRuns) throw new Error("gh run list failed: HTTP 502");
      return runs;
    },
  };
  return { github, record };
}

afterEach(() => {
  for (const { calls } of stubs.splice(0)) {
    assert.deepEqual(calls.filter((call) => WRITES.includes(call)), [], "the status made a GitHub write");
  }
});

const run = (overrides: Parameters<typeof stub>[0] = {}) => {
  const { github, record } = stub(overrides);
  const report = buildStatus(github, NOW);
  return { report, record, text: renderStatus(report) };
};

const entry = (report: ReturnType<typeof buildStatus>, number: number): Extract<PullRequestStatus, { held: unknown }> => {
  const found = report.pullRequests.find((candidate) => candidate.number === number);
  assert.ok(found && "held" in found, `PR #${number} has no status entry`);
  return found;
};

const workflowRun = (id: number, status: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  status,
  event: "issues",
  displayTitle: `Run ${id}`,
  headBranch: "main",
  createdAt: "2026-10-20T11:40:00Z",
  url: `https://github.com/o/r/actions/runs/${id}`,
  ...overrides,
});

describe("followUpPassesUsed", () => {
  it("counts the host's FOLLOW_UP_MARKER comments, since the PR was created when needs-human was never removed", () => {
    const used = followUpPassesUsed(reads([markerComment("2026-10-02T00:00:00Z"), markerComment("2026-10-03T00:00:00Z")]), HOST);

    assert.equal(used, 2);
  });

  it("counts only the comments since sandcastle:needs-human was last removed, so a PR handed back and picked up again shows its new count", () => {
    const timeline: TimelineLabelEvent[] = [
      { event: "labeled", label: "sandcastle:needs-human", createdAt: "2026-10-04T00:00:00Z" },
      { event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-05T00:00:00Z" },
    ];
    const comments = [
      markerComment("2026-10-02T00:00:00Z"),
      markerComment("2026-10-03T00:00:00Z"),
      markerComment("2026-10-03T12:00:00Z"),
      markerComment("2026-10-06T00:00:00Z"),
    ];

    assert.equal(followUpPassesUsed(reads(comments, timeline), HOST), 1);
  });

  it("counts from the latest of several removals", () => {
    const timeline: TimelineLabelEvent[] = [
      { event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-03T00:00:00Z" },
      { event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-07T00:00:00Z" },
    ];
    const comments = [markerComment("2026-10-04T00:00:00Z"), markerComment("2026-10-08T00:00:00Z"), markerComment("2026-10-09T00:00:00Z")];

    assert.equal(followUpPassesUsed(reads(comments, timeline), HOST), 2);
  });

  it("doesn't count a removal of another label", () => {
    const timeline: TimelineLabelEvent[] = [{ event: "unlabeled", label: REVIEW_LABEL, createdAt: "2026-10-05T00:00:00Z" }];

    assert.equal(followUpPassesUsed(reads([markerComment("2026-10-04T00:00:00Z")], timeline), HOST), 1);
  });

  it("doesn't count the same marker posted by a stranger", () => {
    const used = followUpPassesUsed(reads([markerComment("2026-10-02T00:00:00Z", "stranger"), markerComment("2026-10-03T00:00:00Z")]), HOST);

    assert.equal(used, 1);
  });

  it("doesn't count a hand-back comment, which carries GIVE_UP_MARKER", () => {
    const used = followUpPassesUsed(reads([markerComment("2026-10-02T00:00:00Z", HOST, GIVE_UP_MARKER)]), HOST);

    assert.equal(used, 0);
  });

  it("doesn't count a comment without the marker", () => {
    const used = followUpPassesUsed(reads([{ body: "Looks good", createdAt: "2026-10-02T00:00:00Z", author: HOST }]), HOST);

    assert.equal(used, 0);
  });
});

describe("threadCounts", () => {
  it("counts unresolved bot, owner, other people's and unchecked threads apart, and ignores resolved ones", () => {
    const counts = threadCounts(
      pr({
        threads: [botThread(), thread(OWNER), thread("stranger"), thread("ghost"), botThread({ resolved: true }), thread("stranger", { resolved: true })],
      }),
      isOwner,
      HOST,
    );

    assert.deepEqual(counts, { bot: 1, owner: 1, others: 1, unknown: 1, answered: 0, replyUnknown: 0 });
  });

  it("counts a null author, a deleted account, as someone else's", () => {
    assert.equal(threadCounts(pr({ threads: [thread(null)] }), isOwner, HOST).others, 1);
  });

  it("counts a bot thread whose newest judging comment is the host's reply as answered, still a bot thread", () => {
    const answered = botThread({
      recentComments: [
        { author: BOT, byBot: true, body: "Consider a null check." },
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined: it can't be null.` },
      ],
    });

    assert.deepEqual(threadCounts(pr({ threads: [answered] }), isOwner, HOST), { bot: 1, owner: 0, others: 0, unknown: 0, answered: 1, replyUnknown: 0 });
  });

  it("counts an owner thread the host answered as answered", () => {
    const answered = thread(OWNER, {
      recentComments: [
        { author: OWNER, byBot: false, body: "Why?" },
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nBecause.` },
      ],
    });

    assert.deepEqual(threadCounts(pr({ threads: [answered] }), isOwner, HOST), { bot: 0, owner: 1, others: 0, unknown: 0, answered: 1, replyUnknown: 0 });
  });

  it("doesn't count a bot thread as answered when a bot commented after the host", () => {
    const reopened = botThread({
      recentComments: [
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` },
        { author: BOT, byBot: true, body: "Still wrong." },
      ],
    });

    assert.equal(threadCounts(pr({ threads: [reopened] }), isOwner, HOST).answered, 0);
  });

  it("counts a thread a stranger replied on after the host's answer as still answered", () => {
    const answered = botThread({
      recentComments: [
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` },
        { author: "stranger", byBot: false, body: "+1" },
      ],
    });

    assert.equal(threadCounts(pr({ threads: [answered] }), isOwner, HOST).answered, 1);
  });

  it("counts an answered thread whose later replier couldn't be checked under replyUnknown", () => {
    const answered = botThread({
      recentComments: [
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` },
        { author: "ghost", byBot: false, body: "still wrong" },
      ],
    });

    assert.deepEqual(threadCounts(pr({ threads: [answered] }), isOwner, HOST), { bot: 1, owner: 0, others: 0, unknown: 0, answered: 1, replyUnknown: 1 });
  });

  it("doesn't count an unchecked replier who commented before the host's answer", () => {
    const answered = botThread({
      recentComments: [
        { author: "ghost", byBot: false, body: "hm" },
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` },
      ],
    });

    assert.equal(threadCounts(pr({ threads: [answered] }), isOwner, HOST).replyUnknown, 0);
  });

  it("counts no threads for a PR without any", () => {
    assert.deepEqual(threadCounts(pr(), isOwner, HOST), { bot: 0, owner: 0, others: 0, unknown: 0, answered: 0, replyUnknown: 0 });
  });
});

describe("checkSummary", () => {
  it("counts the checks, those still running and the names of the completed red ones", () => {
    const summary = checkSummary([
      { name: "build", completed: true, green: true, completedAt: RECENT },
      { name: "lint", completed: true, green: false, completedAt: RECENT },
      { name: "e2e", completed: false, green: false, completedAt: null },
    ]);

    assert.deepEqual(summary, { total: 3, running: 1, red: ["lint"] });
  });

  it("is all zeros for a PR with no checks", () => {
    assert.deepEqual(checkSummary([]), { total: 0, running: 0, red: [] });
  });
});

describe("heldReason", () => {
  const admitted = { kind: "swept", subject: { kind: "issue", issueNumber: 42 } } as const;

  it("passes a skip through unchanged", () => {
    const admission = { kind: "skipped", reason: "it's a draft", unknown: false } as const;

    assert.deepEqual(heldReason(admission, pr(), NOW, isOwner, HOST, 0), { kind: "skipped", reason: "it's a draft", unknown: false });
  });

  it("keeps the flag that an owner check couldn't answer on a skip", () => {
    const admission = { kind: "skipped", reason: "couldn't check", unknown: true } as const;

    assert.deepEqual(heldReason(admission, pr(), NOW, isOwner, HOST, 0), { kind: "skipped", reason: "couldn't check", unknown: true });
  });

  it("passes a restore through unchanged", () => {
    const admission = { kind: "restore", label: "sandcastle:needs-human", reason: "put back sandcastle:needs-human" } as const;

    assert.deepEqual(heldReason(admission, pr(), NOW, isOwner, HOST, 0), {
      kind: "restore",
      label: "sandcastle:needs-human",
      reason: "put back sandcastle:needs-human",
    });
  });

  it("decides a swept PR with decide", () => {
    const behind = pr({ mergeStateStatus: "BEHIND" });

    assert.deepEqual(heldReason(admitted, behind, NOW, isOwner, HOST, 0), {
      kind: "decided",
      decision: decide(behind, NOW, isOwner, HOST),
      handsBack: false,
    });
  });

  it("says the next pass hands a PR back when it needs a pass and its passes are used up", () => {
    const held = heldReason(admitted, pr({ mergeStateStatus: "DIRTY" }), NOW, isOwner, HOST, FOLLOW_UP_PASS_CAP);

    assert.equal(held.kind === "decided" && held.decision.action, "needs-pass");
    assert.equal(held.kind === "decided" && held.handsBack, true);
  });

  it("doesn't say hand back for a PR that needs a pass with a pass left", () => {
    const held = heldReason(admitted, pr({ mergeStateStatus: "DIRTY" }), NOW, isOwner, HOST, FOLLOW_UP_PASS_CAP - 1);

    assert.equal(held.kind === "decided" && held.handsBack, false);
  });

  it("doesn't say hand back for a PR that only waits, even with its passes used up", () => {
    const held = heldReason(admitted, pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] }), NOW, isOwner, HOST, FOLLOW_UP_PASS_CAP);

    assert.equal(held.kind === "decided" && held.decision.action, "wait");
    assert.equal(held.kind === "decided" && held.handsBack, false);
  });
});

describe("buildStatus' list of Sandcastle PRs", () => {
  it("lists a Sandcastle PR and a labelled hand-off PR, by number, and counts the other open PRs without listing them", () => {
    const { report } = run({ prs: [unlabelledHandOff({ number: 105 }), handOff(), pr(), unlabelledHandOff({ number: 104 })] });

    assert.deepEqual(report.pullRequests.map((status) => status.number), [101, 102]);
    assert.equal(report.othersOpen, 2);
  });

  it("reports the login it judged against, and PRs with the marker from another author, when gh is signed in as someone else", () => {
    // Arrange
    const { github } = stub({ prs: [pr(), pr({ number: 106, author: "other-bot" }), unlabelledHandOff({ number: 107 })] });
    const out: string[] = [];

    // Act
    const code = statusCommand({ ...github, hostLogin: () => "collaborator" }, NOW, (text) => void out.push(text));

    // Assert
    const text = out.join("\n");
    assert.equal(code, 1);
    assert.ok(text.includes("Judged against the host login collaborator"), text);
    assert.ok(text.includes("PR #101, opened by sandcastle-bot"), text);
    assert.ok(text.includes("PR #106, opened by other-bot"), text);
    assert.ok(!text.includes("PR #107, opened by"), text);
    assert.ok(text.includes("this status is partial"), text);
  });

  it("names the host login and exits 0 when no marked PR is by another author", () => {
    // Arrange
    const { github } = stub({ prs: [pr(), unlabelledHandOff({ number: 107 })] });
    const out: string[] = [];

    // Act
    const code = statusCommand(github, NOW, (text) => void out.push(text));

    // Assert
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes(`Judged against the host login ${HOST}`), out.join("\n"));
  });

  it("lists a Sandcastle PR the sweep skips, with the skip reason", () => {
    const labelled = pr({ labels: ["sandcastle:needs-human"] });

    const { report } = run({ prs: [labelled] });

    assert.deepEqual(entry(report, 101).held, { kind: "skipped", reason: sweepSkipReason(labelled, IN_SCOPE, HOST, new Set(), true), unknown: false });
  });

  it("lists a labelled PR even when the run doesn't follow hand-offs, as a skip", () => {
    const { report } = run({ prs: [handOff()], follows: false });

    assert.equal(entry(report, 102).held.kind, "skipped");
  });

  it("gives each entry its number, title, URL and the issue its branch names", () => {
    const { report } = run({ prs: [pr(), handOff()] });

    assert.deepEqual(
      [entry(report, 101).title, entry(report, 101).url, entry(report, 101).issueNumber],
      ["Add search (#101)", "https://github.com/o/r/pull/101", 42],
    );
    assert.equal(entry(report, 102).issueNumber, undefined);
    assert.equal(entry(report, 102).handOff, true);
    assert.equal(entry(report, 101).handOff, false);
  });

  it("reads the passes of each listed PR only", () => {
    const { record } = run({ prs: [pr(), handOff(), unlabelledHandOff()] });

    assert.deepEqual(record.calls.filter((call) => call.startsWith("passComments")).sort(), ["passComments:101", "passComments:102"]);
  });

  it("reports each PR's passes used since needs-human was last removed", () => {
    const timeline: TimelineLabelEvent[] = [{ event: "unlabeled", label: "sandcastle:needs-human", createdAt: "2026-10-05T00:00:00Z" }];
    const comments = [markerComment("2026-10-02T00:00:00Z"), markerComment("2026-10-03T00:00:00Z"), markerComment("2026-10-06T00:00:00Z")];

    const { report } = run({ prs: [pr(), handOff()], comments: { 101: reads(comments, timeline), 102: passesUsed(2) } });

    assert.equal(entry(report, 101).passesUsed, 1);
    assert.equal(entry(report, 102).passesUsed, 2);
  });

  it("reports the unresolved threads, the merge state, the checks and the labels of each PR", () => {
    const { report } = run({
      prs: [pr({ mergeStateStatus: "BLOCKED", labels: [REVIEW_LABEL], threads: [botThread(), thread("stranger")] })],
    });

    const status = entry(report, 101);
    assert.deepEqual(status.threads, { bot: 1, owner: 0, others: 1, unknown: 0, answered: 0, replyUnknown: 0 });
    assert.equal(status.mergeStateStatus, "BLOCKED");
    assert.deepEqual(status.checks, { total: 1, running: 0, red: [] });
    assert.equal(status.reviewLabel, true);
    assert.equal(status.needsHuman, false);
  });

  it("reports sandcastle:needs-human whatever its case", () => {
    const { report } = run({ prs: [pr({ labels: ["Sandcastle:Needs-Human"] })] });

    assert.equal(entry(report, 101).needsHuman, true);
  });

  it("reads through the sweep's context first: the host, then the in-scope issues, then whether hand-offs are followed", () => {
    const { record } = run();

    assert.deepEqual(record.calls.slice(0, 3), ["hostLogin", "inScopeIssues", "followsHandOffs"]);
    assert.ok(record.calls.indexOf("openPullRequests") > 2);
  });
});

describe("buildStatus' reason a PR is held", () => {
  const cases: { name: string; prs: SweepPullRequest[]; events?: Record<number, IssueEvent[]>; shown: string[]; hidden?: string[] }[] = [
    {
      name: "merge conflicts",
      prs: [pr({ mergeStateStatus: "DIRTY" })],
      shown: ["needs a follow-up pass", "it has merge conflicts"],
    },
    {
      name: "checks still running",
      prs: [pr({ checks: [{ name: "build", completed: false, green: false, completedAt: null }] })],
      shown: ["waits: checks are still running"],
    },
    {
      name: "no checks reported",
      prs: [pr({ checks: [] })],
      shown: ["waits: no checks have reported"],
    },
    {
      name: "a red check",
      prs: [pr({ checks: [{ name: "build", completed: true, green: false, completedAt: RECENT }] })],
      shown: ["needs a follow-up pass", "check build is red"],
    },
    {
      name: "an unresolved bot thread",
      prs: [pr({ threads: [botThread()] })],
      shown: ["needs a follow-up pass", "1 unresolved bot thread(s)"],
    },
    {
      name: "an unresolved owner thread",
      prs: [pr({ threads: [thread(OWNER)] })],
      shown: ["needs a follow-up pass", "1 unresolved owner thread(s)"],
    },
    {
      name: "Copilot's review pending",
      prs: [pr({ reviews: [], reviewRequests: [COPILOT_REVIEWER] })],
      shown: ["waits: Copilot's review is pending"],
    },
    {
      name: "Copilot's review missing, soon after CI",
      prs: [pr({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt: RECENT }] })],
      shown: ["waits: Copilot hasn't reviewed the head yet"],
    },
    {
      name: "Copilot's review missing, long after CI",
      prs: [pr({ reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt: STALE }] })],
      shown: ["asks Copilot again to review its head"],
    },
    {
      name: "only behind main",
      prs: [pr({ mergeStateStatus: "BEHIND" })],
      shown: ["only behind main: the next sweep updates its branch"],
      hidden: ["left behind main"],
    },
    {
      name: "behind main with a bot thread to answer first",
      prs: [pr({ mergeStateStatus: "BEHIND", threads: [botThread()] })],
      shown: ["1 unresolved bot thread(s)", "BEHIND (left behind main until nothing else holds it)"],
    },
    {
      name: "labelled sandcastle:needs-human",
      prs: [pr({ labels: ["sandcastle:needs-human"] })],
      shown: ["the sweep skips it: it's labelled sandcastle:needs-human", "sandcastle:needs-human: yes"],
    },
    {
      name: "settled",
      prs: [pr()],
      shown: ["left alone: it's settled and CLEAN"],
    },
    {
      name: "a draft",
      prs: [pr({ isDraft: true })],
      shown: ["the sweep skips it: it's a draft"],
    },
    {
      name: "a hand-off label a stranger added",
      prs: [handOff()],
      events: { 102: [{ ...ownerAdd, actor: "stranger" }] },
      shown: ["the sweep skips it:"],
    },
  ];

  for (const { name, prs, events, shown, hidden = [] } of cases) {
    it(`gives the reason for ${name}, the one the sweep's own functions give`, () => {
      const target = prs[0]!;

      const { report, text } = run({ prs, ...(events === undefined ? {} : { events }) });

      const held = entry(report, target.number).held;
      if (held.kind === "skipped") {
        const events102 = events?.[102] ?? [];
        const expected = target.labels.includes(FOLLOW_UP_LABEL)
          ? approval(FOLLOW_UP_LABEL, events102, [], isOwner)
          : { approved: false as const, reason: sweepSkipReason(target, IN_SCOPE, HOST, new Set(), true) };
        assert.equal(held.reason, expected.approved ? undefined : expected.reason);
        assert.ok(text.includes(held.reason), text);
      } else {
        assert.equal(held.kind, "decided");
        assert.deepEqual(held.kind === "decided" && held.decision, decide(target, NOW, isOwner, HOST));
      }
      for (const fragment of shown) {
        assert.ok(text.includes(fragment), `expected "${fragment}" in:\n${text}`);
      }
      for (const fragment of hidden) {
        assert.ok(!text.includes(fragment), `didn't expect "${fragment}" in:\n${text}`);
      }
    });
  }

  it("holds an approved hand-off PR to decide, like the sweep", () => {
    const labelled = handOff({ mergeStateStatus: "DIRTY" });

    const { report, text } = run({ prs: [labelled] });

    assert.deepEqual(entry(report, 102).held, { kind: "decided", decision: decide(labelled, NOW, isOwner, HOST), handsBack: false });
    assert.ok(text.includes("it has merge conflicts"), text);
  });

  it("says the sweep puts back sandcastle:needs-human a stranger removed, and leaves the PR alone, without putting it back", () => {
    const events = [{ event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" } as const];

    const { report, text } = run({ prs: [pr()], events: { 101: [...events] } });

    const held = entry(report, 101).held;
    assert.equal(held.kind, "restore");
    assert.equal(held.kind === "restore" && held.label, "sandcastle:needs-human");
    assert.ok(text.includes("leaves the PR alone this round"), text);
  });

  it("says a PR that needs a pass with its passes used up is handed back by the next pass", () => {
    const { report, text } = run({ prs: [pr({ mergeStateStatus: "DIRTY" })], comments: { 101: passesUsed(FOLLOW_UP_PASS_CAP) } });

    const held = entry(report, 101).held;
    assert.equal(held.kind === "decided" && held.handsBack, true);
    assert.ok(text.includes("Follow-up passes: 3 of 3"), text);
    assert.ok(text.includes("hands it back"), text);
    assert.ok(text.includes("sandcastle:needs-human"), text);
  });

  it("doesn't say hand back for a PR that needs a pass with 2 of 3 used", () => {
    const { text } = run({ prs: [pr({ mergeStateStatus: "DIRTY" })], comments: { 101: passesUsed(2) } });

    assert.ok(text.includes("Follow-up passes: 2 of 3"), text);
    assert.ok(!text.includes("hands it back"), text);
  });

  it("doesn't say hand back for a PR that only waits, with 3 of 3 used", () => {
    const { text } = run({ prs: [pr({ checks: [] })], comments: { 101: passesUsed(3) } });

    assert.ok(!text.includes("hands it back"), text);
  });
});

describe("renderStatus' entry for a PR", () => {
  it("opens with the PR's number, title and issue, then its passes as N of 3", () => {
    const { text } = run({ comments: { 101: passesUsed(2) } });

    assert.ok(text.includes("PR #101 Add search (#101) (issue #42)"), text);
    assert.ok(text.includes("Follow-up passes: 2 of 3"), text);
  });

  it("leaves the issue out for a hand-off PR on a chore branch", () => {
    const { text } = run({ prs: [handOff()] });

    assert.ok(text.includes("PR #102"), text);
    assert.ok(!text.includes("(issue #"), text);
  });

  it("shows the merge state, the checks and both labels", () => {
    const { text } = run({ prs: [pr({ labels: [REVIEW_LABEL] })] });

    assert.ok(text.includes("Merge state: CLEAN"), text);
    assert.ok(text.includes("Checks: all 1 green"), text);
    assert.ok(text.includes("sandcastle:needs-human: no"), text);
    assert.ok(text.includes("review:claude: yes"), text);
  });

  it("shows a PR without review:claude as no", () => {
    const { text } = run();

    assert.ok(text.includes("review:claude: no"), text);
  });

  it("splits the unresolved threads into bot, owner and waiting on someone else", () => {
    const { text } = run({ prs: [pr({ threads: [botThread(), thread(OWNER), thread("stranger")] })] });

    assert.ok(text.includes("1 bot"), text);
    assert.ok(text.includes("1 owner"), text);
    assert.ok(text.includes("1 waiting on someone else"), text);
  });

  it("mentions threads whose author couldn't be checked and threads the host answered only when there are some", () => {
    const answered = botThread({ recentComments: [{ author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` }] });
    const withBoth = run({ prs: [pr({ threads: [thread("ghost"), answered] })] }).text;
    const without = run({ prs: [pr({ threads: [botThread()] })] }).text;

    assert.ok(withBoth.includes("1 whose author couldn't be checked"), withBoth);
    assert.ok(withBoth.includes("1 answered by Sandcastle and waiting on the owner"), withBoth);
    assert.ok(!without.includes("couldn't be checked"), without);
    assert.ok(!without.includes("answered by Sandcastle"), without);
  });

  it("names a red check", () => {
    const { text } = run({ prs: [pr({ checks: [{ name: "lint", completed: true, green: false, completedAt: RECENT }] })] });

    assert.ok(text.includes("lint"), text);
  });

  it("closes with the count of other open PRs", () => {
    const { text } = run({ prs: [pr(), unlabelledHandOff({ number: 104 }), unlabelledHandOff({ number: 105 })] });

    assert.ok(text.includes("2 other open PRs into main aren't Sandcastle's."), text);
  });
});

describe("buildStatus' workflow runs", () => {
  it("lists the run in progress and the queued run with their event and title", () => {
    const { report, text } = run({
      runs: [
        workflowRun(123, "in_progress", { displayTitle: "Show why each Sandcastle PR is held" }),
        workflowRun(124, "pending", { event: "pull_request_target", displayTitle: "Add search", createdAt: "2026-10-20T11:50:00Z" }),
      ],
    });

    assert.ok("running" in report.runs);
    assert.deepEqual("running" in report.runs && report.runs.running.map((entry) => entry.id), [123]);
    assert.deepEqual("queued" in report.runs && report.runs.queued.map((entry) => entry.id), [124]);
    assert.ok(text.includes("Sandcastle workflow"), text);
    assert.ok(text.includes("run 123"), text);
    assert.ok(text.includes('issues: "Show why each Sandcastle PR is held"'), text);
    assert.ok(text.includes("run 124"), text);
    assert.ok(text.includes('pull_request_target: "Add search"'), text);
    assert.ok(!text.includes("No Sandcastle run is in progress."), text);
    assert.ok(!text.includes("No Sandcastle run is queued."), text);
  });

  it("sorts every status but in_progress into the queued list", () => {
    const { report } = run({ runs: [workflowRun(1, "queued"), workflowRun(2, "requested"), workflowRun(3, "waiting"), workflowRun(4, "pending")] });

    assert.ok("queued" in report.runs);
    assert.deepEqual("queued" in report.runs && report.runs.queued.map((entry) => entry.id), [1, 2, 3, 4]);
    assert.deepEqual("running" in report.runs && report.runs.running, []);
  });

  it("names the branch of a run that isn't on main", () => {
    const { text } = run({ runs: [workflowRun(123, "in_progress", { headBranch: "feature/65-show-why" })] });

    assert.ok(text.includes("feature/65-show-why"), text);
  });

  it("doesn't name main", () => {
    const { text } = run({ runs: [workflowRun(123, "in_progress", { headBranch: "main" })] });

    assert.ok(!/\bmain\b/.test(text.split("\n").filter((line) => line.includes("run 123")).join("\n")), text);
  });

  it("says there are no runs when there are none", () => {
    const { text } = run({ runs: [] });

    assert.ok(text.includes("No Sandcastle run is in progress."), text);
    assert.ok(text.includes("No Sandcastle run is queued."), text);
  });

  it("puts the runs before the PRs", () => {
    const { text } = run();

    assert.ok(text.indexOf("Sandcastle workflow") < text.indexOf("PR #101"), text);
  });

  it("still lists the PRs when the runs can't be read, and shows the error", () => {
    const { report, text } = run({ failRuns: true });

    assert.deepEqual(report.runs, { error: "gh run list failed: HTTP 502" });
    assert.equal(report.pullRequests.length, 1);
    assert.ok(text.includes("PR #101"), text);
    assert.ok(text.includes("gh run list failed: HTTP 502"), text);
  });
});

describe("buildStatus when a read for one PR fails", () => {
  it("gives that PR an error entry and still reports the others, when its pass comments can't be read", () => {
    const { report, text } = run({ prs: [pr(), handOff()], failPassComments: [102] });

    assert.equal(entry(report, 101).held.kind, "decided");
    const failed = report.pullRequests.find((status) => status.number === 102);
    assert.ok(failed && "error" in failed);
    assert.match("error" in failed ? failed.error : "", /HTTP 500/);
    assert.ok(text.includes("PR #102"), text);
    assert.ok(text.includes("couldn't read its status"), text);
    assert.ok(text.includes("PR #101 Add search (#101) (issue #42)"), text);
  });

  it("gives that PR an error entry when its events can't be read", () => {
    const { report } = run({ prs: [pr(), pr({ number: 104, headRefName: BRANCH })], failEvents: [104] });

    assert.ok("error" in report.pullRequests.find((status) => status.number === 104)!);
    assert.ok("held" in report.pullRequests.find((status) => status.number === 101)!);
  });
});

describe("statusCommand", () => {
  it("prints the report and exits 0 when everything was read", () => {
    const { github } = stub({ runs: [workflowRun(123, "in_progress")] });
    const out: string[] = [];

    const code = statusCommand(github, NOW, (text) => void out.push(text));

    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("PR #101"), out.join("\n"));
    assert.ok(out.join("\n").includes("run 123"), out.join("\n"));
  });

  it("exits 1 after printing the rest when a PR's status couldn't be read", () => {
    const { github } = stub({ prs: [pr(), handOff()], failPassComments: [102] });
    const out: string[] = [];

    const code = statusCommand(github, NOW, (text) => void out.push(text));

    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("PR #101"), out.join("\n"));
  });

  it("exits 1 when the owner check failed for the label that handed a PR off", () => {
    const { github } = stub({ prs: [handOff()] });
    const out: string[] = [];

    const code = statusCommand({ ...github, isOwner: () => undefined }, NOW, (text) => void out.push(text));

    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("this status is partial"), out.join("\n"));
  });

  it("exits 1 when the owner check failed for the actor who removed sandcastle:needs-human", () => {
    const events = [{ event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" } as const];
    const { github } = stub({ prs: [pr()], events: { 101: [...events] } });

    const code = statusCommand({ ...github, isOwner: () => undefined }, NOW, () => {});

    assert.equal(code, 1);
  });

  it("exits 1 and says so when a reply after the host's answer came from an author that couldn't be checked", () => {
    const answered = botThread({
      recentComments: [
        { author: HOST, byBot: false, body: `${FOLLOW_UP_REPLY_MARKER}\nDeclined.` },
        { author: "ghost", byBot: false, body: "still wrong" },
      ],
    });
    const { github } = stub({ prs: [pr({ threads: [answered] })] });
    const out: string[] = [];

    const code = statusCommand(github, NOW, (text) => void out.push(text));

    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("1 with a reply whose author couldn't be checked"), out.join("\n"));
  });

  it("exits 1 when a thread's author couldn't be checked", () => {
    const { github } = stub({ prs: [pr({ threads: [thread("ghost")] })] });

    assert.equal(statusCommand(github, NOW, () => {}), 1);
  });

  it("exits 1 and names the issue when a queue owner check couldn't answer", () => {
    const line = "  ⊘ #42 is skipped: couldn't check whether @ghost, who added Sandcastle, is the repository owner.";
    const { github } = stub({ unchecked: [line] });
    const out: string[] = [];

    const code = statusCommand(github, NOW, (text) => void out.push(text));

    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("#42 is skipped: couldn't check whether @ghost"), out.join("\n"));
    assert.ok(out.join("\n").includes("this status is partial"), out.join("\n"));
  });

  it("exits 1 when the runs couldn't be read", () => {
    const { github } = stub({ failRuns: true });

    assert.equal(statusCommand(github, NOW, () => {}), 1);
  });

  it("prints that it couldn't read the status and exits 1 when the open PRs can't be read", () => {
    const { github } = stub({ failOpen: true });
    const out: string[] = [];

    const code = statusCommand(github, NOW, (text) => void out.push(text));

    assert.equal(code, 1);
    assert.ok(out.join("\n").includes("Couldn't read Sandcastle's status:"), out.join("\n"));
    assert.ok(out.join("\n").includes("HTTP 502"), out.join("\n"));
  });
});

describe("the status makes no GitHub write", () => {
  it("calls none of the host's write members across a PR of every kind", () => {
    const { record } = run({
      prs: [
        pr({ mergeStateStatus: "BEHIND" }),
        pr({ number: 104, headRefName: "feature/42-add-search", reviews: [], checks: [{ name: "build", completed: true, green: true, completedAt: STALE }] }),
        pr({ number: 105, labels: [] }),
        handOff({ mergeStateStatus: "DIRTY" }),
      ],
      events: { 105: [{ event: "unlabeled", actor: "stranger", label: "sandcastle:needs-human", createdAt: "2026-10-10T09:00:00Z" }] },
    });

    assert.deepEqual(record.calls.filter((call) => WRITES.includes(call)), []);
  });
});

describe("withoutLabelWrites", () => {
  function base() {
    const calls: string[] = [];
    const github: QueueGitHub = {
      issuesInScope: () => (calls.push("issuesInScope"), [{ number: 7, title: "T", body: "B", labels: ["Sandcastle", "sandcastle:ready"], comments: [] }]),
      events: () => (calls.push("events"), [
        { event: "labeled", actor: OWNER, label: "Sandcastle", createdAt: "2026-10-01T00:00:00Z" },
        { event: "labeled", actor: "stranger", label: "sandcastle:ready", createdAt: "2026-10-02T00:00:00Z" },
      ]),
      bodyEdits: () => (calls.push("bodyEdits"), []),
      isOwner,
      removeLabel: () => void calls.push("removeLabel"),
      addLabel: () => void calls.push("addLabel"),
    };
    return { github, calls };
  }

  it("never calls the base host's removeLabel or addLabel", () => {
    const { github, calls } = base();

    const wrapped = withoutLabelWrites(github);
    wrapped.removeLabel(7, "sandcastle:ready");
    wrapped.addLabel(7, "sandcastle:needs-human");

    assert.deepEqual(calls, []);
  });

  it("still reads through the base host", () => {
    const { github, calls } = base();

    const wrapped = withoutLabelWrites(github);
    wrapped.events(7);
    wrapped.bodyEdits(7);

    assert.deepEqual(calls, ["events", "bodyEdits"]);
    assert.equal(wrapped.isOwner(OWNER), true);
  });

  it("lets loadQueue drop an untrusted sandcastle:ready from what it returns, with nothing written", () => {
    const { github, calls } = base();

    const kept = loadQueue({ kind: "label", label: "Sandcastle" }, withoutLabelWrites(github), () => {}, new Set(), new Map());

    assert.deepEqual(kept.map((issue) => issue.number), [7]);
    assert.deepEqual(kept[0]!.labels, ["Sandcastle"]);
    assert.ok(!calls.includes("removeLabel") && !calls.includes("addLabel"), calls.join(","));
  });
});

describe("readInScopeIssues", () => {
  const scope = { kind: "label", label: "Sandcastle" } as const;
  const queue = (isOwnerOfAdder: IsOwner): QueueGitHub => ({
    issuesInScope: () => [{ number: 42, title: "Unchecked", body: "B", labels: ["Sandcastle"], comments: [] }],
    events: () => [{ event: "labeled", actor: "ghost", label: "Sandcastle", createdAt: "2026-10-01T00:00:00Z" }],
    bodyEdits: () => [],
    isOwner: isOwnerOfAdder,
    removeLabel: () => {},
    addLabel: () => {},
  });

  it("leaves out an issue whose adder couldn't be checked and returns loadQueue's line for it", () => {
    // Arrange
    const github = queue(isOwner);

    // Act
    const read = readInScopeIssues(github, scope);

    // Assert
    assert.deepEqual(read.issues, []);
    assert.equal(read.unchecked.length, 1);
    assert.ok(read.unchecked[0]!.includes("#42 is skipped: couldn't check whether @ghost"));
  });

  it("returns no unchecked line for an issue loadQueue could check", () => {
    // Arrange
    const github = queue((login) => login === "ghost");

    // Act
    const read = readInScopeIssues(github, scope);

    // Assert
    assert.deepEqual(read.issues.map((issue) => issue.number), [42]);
    assert.deepEqual(read.unchecked, []);
  });
});

// The status is read-only because it never imports a write. Tests can't see
// a call the stub doesn't offer, so the source is checked too.
describe("lib/status.mts' imports", () => {
  const source = readFileSync(new URL("./status.mts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s*"[^"]+";/gms)].map((match) => match[0]);

  it("imports none of the GitHub writes, the Sandcastle package or the follow-up pass", () => {
    const forbidden = [
      "requestCopilotReview",
      "updatePullRequestBranch",
      "handBack",
      "addPullRequestLabel",
      "addIssueLabel",
      "removeIssueLabel",
      "addLabelOn",
      "removeLabelFrom",
      "@ai-hero/sandcastle",
      "follow-up-pass.mts",
    ];
    for (const name of forbidden) {
      assert.ok(!imports.some((line) => line.includes(name)), `lib/status.mts imports ${name}`);
    }
  });

  it("reuses the sweep's own admission, decision and pass count rather than re-deriving them", () => {
    const joined = imports.join("\n");

    assert.match(joined, /\badmitToSweep\b/);
    assert.match(joined, /\bsweepContext\b/);
    assert.match(joined, /\bdecide\b/);
    assert.match(joined, /\bmarkerCommentsSince\b/);
    assert.match(joined, /\bmarkerCommentReads\b/);
    assert.match(joined, /\bsandcastleWorkflowRuns\b/);
  });

  it("reads the in-scope issues through loadQueue with its label writes removed, never liveFollowUpGitHub's", () => {
    assert.match(source, /loadQueue\(scope, withoutLabelWrites\(github\)/);
    assert.match(source, /readInScopeIssues\(liveQueueGitHub\(\)\)/);
    assert.ok(!source.includes("liveFollowUpGitHub.inScopeIssues"));
  });

  it("reaches only the read members of liveFollowUpGitHub", () => {
    const reads = ["hostLogin", "openPullRequests", "isOwner", "pullRequestEvents", "pullRequestBodyEdits", "followsHandOffs"];
    const used = [...source.matchAll(/\bliveFollowUpGitHub\.(\w+)/g)].map((match) => match[1]!);

    assert.ok(used.length > 0);
    for (const member of used) {
      assert.ok(reads.includes(member), `lib/status.mts uses liveFollowUpGitHub.${member}, which isn't a read`);
    }
    // Passing the whole host along, or spreading it, would reach its writes too.
    const body = imports.reduce((rest, line) => rest.replace(line, ""), source);
    assert.equal([...body.matchAll(/\bliveFollowUpGitHub\b(?!\.)/g)].length, 0);
  });

  it("uses liveQueueGitHub only inside readInScopeIssues, which wraps it in withoutLabelWrites", () => {
    const uses = [...source.matchAll(/\bliveQueueGitHub\(\)/g)];

    assert.equal(uses.length, 1);
    assert.match(source, /readInScopeIssues\(liveQueueGitHub\(\)\)/);
    assert.match(source, /loadQueue\(scope, withoutLabelWrites\(github\)/);
    assert.doesNotMatch(source, /loadQueue\([^)]*liveQueueGitHub/);
  });

  it("always reads the default Sandcastle queue scope", () => {
    assert.ok(!source.includes("SANDCASTLE_ISSUE"));
    assert.ok(!source.includes("SANDCASTLE_LABEL"));
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withSharedRules } from "./agents.mts";
import type { PromptThread } from "./follow-up-pass.mts";
import type { PullRequestText, SandcastleIssue } from "./github.mts";
import {
  architectPromptArgs,
  backendPromptArgs,
  briefPromptArgs,
  critiquePromptArgs,
  followUpPromptArgs,
  gateFixerPromptArgs,
  intakePromptArgs,
  issuePromptArgs,
  plannerPromptArgs,
  type PassBrief,
} from "./prompts.mts";

// What ownerApproved (see github.test.mts) leaves of an issue: only the
// comments of authors with write access.
const issue: SandcastleIssue = {
  number: 3,
  title: "Add a thing",
  body: "## Summary\n\nAdd the thing.",
  labels: ["Sandcastle"],
  comments: ["Use the existing helper."],
};

describe("issuePromptArgs", () => {
  it("gives the role the issue's number, title, body and branch", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.ISSUE_TITLE, "Add a thing");
    assert.equal(args.ISSUE_BODY, "## Summary\n\nAdd the thing.");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
  });

  it("gives the role origin/main as the base to diff against, since Sandcastle's TARGET_BRANCH is the sandbox's own branch", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(args.BASE_BRANCH, "origin/main");
  });

  it("includes the owner's comments and no one else's", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.match(args.ISSUE_COMMENTS, /Use the existing helper\./);
    assert.ok(!Object.values(args).some((value) => value.includes("delete the tests")));
  });

  it("says so when the owner hasn't commented", () => {
    const args = issuePromptArgs({ ...issue, comments: [] }, "feature/3-add-a-thing");

    assert.equal(args.ISSUE_COMMENTS, "(no comments)");
  });
});

// #58: a hand-off PR has no Sandcastle issue, so its own title, description
// and comments are the brief a pass's roles work from.
const pullRequest: PullRequestText = {
  number: 58,
  title: "chore: Tidy the docs",
  body: "Moves two files.",
  comments: ["Keep the old names.", "Fine by me."],
};
const prBrief: PassBrief = { kind: "pull-request", pr: pullRequest };
const issueBrief: PassBrief = { kind: "issue", issue };

describe("briefPromptArgs", () => {
  it("gives an issue brief the same arguments issuePromptArgs gives, plus the sentence that names the issue", () => {
    const args = briefPromptArgs(issueBrief, "feature/3-add-a-thing");

    assert.deepEqual(args, { ...issuePromptArgs(issue, "feature/3-add-a-thing"), BRIEF_SOURCE: "The branch implements issue 3" });
  });

  it("gives a pull request brief the PR's title, description and comments in the issue's slots", () => {
    const args = briefPromptArgs(prBrief, "chore/tidy-docs");

    assert.equal(args.ISSUE_TITLE, "chore: Tidy the docs");
    assert.equal(args.ISSUE_BODY, "Moves two files.");
    assert.equal(args.ISSUE_COMMENTS, "Keep the old names.\n\n---\n\nFine by me.");
    assert.equal(args.BRANCH, "chore/tidy-docs");
    assert.equal(args.BASE_BRANCH, "origin/main");
  });

  it("says so when the PR has no comments from anyone with write access", () => {
    const args = briefPromptArgs({ kind: "pull-request", pr: { ...pullRequest, comments: [] } }, "chore/tidy-docs");

    assert.equal(args.ISSUE_COMMENTS, "(no comments)");
  });

  it("tells the role a pull request brief has no Sandcastle issue and that the PR's title and description are the brief", () => {
    const args = briefPromptArgs(prBrief, "chore/tidy-docs");

    assert.match(args.BRIEF_SOURCE, /Pull request #58/);
    assert.match(args.BRIEF_SOURCE, /no Sandcastle issue/);
    assert.match(args.BRIEF_SOURCE, /title and description are the brief/);
    assert.doesNotMatch(args.BRIEF_SOURCE, /implements issue/);
  });

  it("gives every placeholder a value, since Sandcastle refuses one without", () => {
    for (const brief of [issueBrief, prBrief]) {
      const args = briefPromptArgs(brief, "feature/3-add-a-thing");

      for (const key of ["TASK_ID", "ISSUE_TITLE", "ISSUE_BODY", "ISSUE_COMMENTS", "BRANCH", "BASE_BRANCH", "BRIEF_SOURCE"] as const) {
        assert.equal(typeof args[key], "string", `${brief.kind} ${key}`);
        assert.notEqual(args[key], "", `${brief.kind} ${key}`);
      }
    }
  });
});

describe("issuePromptArgs' brief source", () => {
  // Keeps the rendered line of every build role unchanged.
  it("renders the line the build roles had before: the branch implements the issue", () => {
    const args = issuePromptArgs(issue, "feature/3-add-a-thing");

    assert.equal(`${args.BRIEF_SOURCE}: ${args.ISSUE_TITLE}`, "The branch implements issue 3: Add a thing");
  });
});

describe("plannerPromptArgs", () => {
  it("lists the ready issues without anyone else's comments", () => {
    const args = plannerPromptArgs([issue]);

    assert.match(args.ISSUES_JSON, /Use the existing helper\./);
    assert.ok(!args.ISSUES_JSON.includes("delete the tests"));
  });

  it("gives the planner only the ready issues, since the host names branches and skips open PRs", () => {
    const args = plannerPromptArgs([issue]);

    assert.deepEqual(Object.keys(args), ["ISSUES_JSON"]);
  });
});

describe("gateFixerPromptArgs", () => {
  it("preserves issue context and includes the checkpoint and complete gate output", () => {
    const gateOutput = "Line 1\nLine 2\nLine 3";
    const args = gateFixerPromptArgs({ kind: "issue", issue }, "feature/3-add-a-thing", 2, gateOutput);

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.CHECKPOINT, "2");
    assert.equal(args.GATE_OUTPUT, gateOutput);
  });
});

// Covers "After an architect run, the issue has a comment with the design
// note..." (issue #72): on a re-run the architect needs that earlier note
// back, since .sandcastle/work/ is gitignored and may not have survived into
// a fresh sandbox (see lib/build.mts and DESIGN_MARKER in lib/config.mts).
describe("architectPromptArgs", () => {
  it("preserves issue context alongside the design note", () => {
    const args = architectPromptArgs(issue, "feature/3-add-a-thing", "## Design\n\nUse a Result<T>.");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.DESIGN_NOTE, "## Design\n\nUse a Result<T>.");
  });

  it("tells the architect it has no earlier design note on a first run", () => {
    const args = architectPromptArgs(issue, "feature/3-add-a-thing", undefined);

    assert.equal(args.DESIGN_NOTE, "(no earlier design note)");
  });
});

describe("backendPromptArgs", () => {
  it("preserves issue context", () => {
    const args = backendPromptArgs(issue, "feature/3-add-a-thing", false);

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
  });

  it("leaves Blazor components and pages to the UI developer when it runs after the backend", () => {
    assert.match(backendPromptArgs(issue, "feature/3-add-a-thing", true).UI_DEVELOPER, /UI developer runs after you/);
  });

  it("tells the backend its run is the last developer run when no UI developer runs", () => {
    assert.match(backendPromptArgs(issue, "feature/3-add-a-thing", false).UI_DEVELOPER, /last developer run/);
  });
});

describe("intakePromptArgs", () => {
  it("lists the issues to judge without anyone else's comments", () => {
    const args = intakePromptArgs([issue]);

    assert.match(args.ISSUES_JSON, /Use the existing helper\./);
    assert.ok(!args.ISSUES_JSON.includes("delete the tests"));
  });

  it("gives intake only the issues that still need a verdict", () => {
    const args = intakePromptArgs([issue]);

    assert.deepEqual(JSON.parse(args.ISSUES_JSON).map((i: { number: number }) => i.number), [3]);
  });
});

// #78: the follow-up role can't reach GitHub, so everything it learns about
// the PR and its threads travels through these prompt arguments.
describe("followUpPromptArgs", () => {
  const threads: PromptThread[] = [
    {
      threadId: "RT_1",
      from: "bot",
      path: "src/Domain/Result.cs",
      line: 10,
      outdated: false,
      comments: [{ author: "copilot-pull-request-reviewer", body: "Consider returning a Result<T> here." }],
    },
  ];

  it("preserves issue context alongside the PR number and the threads given to the role", () => {
    const args = followUpPromptArgs({ kind: "issue", issue }, "feature/3-add-a-thing", 42, threads, "already contains main.");

    assert.equal(args.TASK_ID, "3");
    assert.equal(args.BRANCH, "feature/3-add-a-thing");
    assert.equal(args.PR_NUMBER, "42");
    assert.deepEqual(JSON.parse(String(args.THREADS_JSON)), threads);
    assert.equal(args.MERGE, "already contains main.");
  });

  it("gives the role an empty JSON array when no thread is for it", () => {
    const args = followUpPromptArgs({ kind: "issue", issue }, "feature/3-add-a-thing", 42, [], "already contains main.");

    assert.deepEqual(JSON.parse(String(args.THREADS_JSON)), []);
  });

  // #79: a red check the gate doesn't cover reaches the role as its log, and
  // only then does CODEQL_LOG say the gate passed: planRedCi only forwards a
  // check once the gate is green, but the prompt mustn't claim that on every
  // run (#79's follow-up review), such as one with only a merge conflict or
  // bot threads to resolve, where the gate never ran on the head at all.
  it("passes the failed-job log of a check the gate doesn't cover as CODEQL_LOG, noting the gate already passed", () => {
    const args = followUpPromptArgs({ kind: "issue", issue }, "feature/3-add-a-thing", 42, [], "already contains main.", "##[error] CS8600");

    assert.match(String(args.CODEQL_LOG), /scripts\/gate\.sh.*passes/);
    assert.match(String(args.CODEQL_LOG), /##\[error\] CS8600/);
  });

  it("still fills CODEQL_LOG when there's no log, since Sandcastle refuses an empty placeholder, without claiming the gate passed", () => {
    const args = followUpPromptArgs({ kind: "issue", issue }, "feature/3-add-a-thing", 42, [], "already contains main.");

    assert.match(String(args.CODEQL_LOG), /no log/i);
    assert.doesNotMatch(String(args.CODEQL_LOG), /gate\.sh/);
  });
});

// #58: both pass roles take a PassBrief, so a hand-off PR's pass works from
// the PR's text.
describe("pass prompt arguments for a pull request brief", () => {
  it("gives the follow-up role the PR's brief with the PR number, threads and merge sentence", () => {
    const args = followUpPromptArgs(prBrief, "chore/tidy-docs", 58, [], "already contains main.");

    assert.equal(args.ISSUE_TITLE, "chore: Tidy the docs");
    assert.match(String(args.BRIEF_SOURCE), /Pull request #58/);
    assert.equal(args.PR_NUMBER, "58");
    assert.equal(args.MERGE, "already contains main.");
    assert.deepEqual(JSON.parse(String(args.THREADS_JSON)), []);
  });

  it("gives the gate-fixer the PR's brief with the checkpoint and gate output", () => {
    const args = gateFixerPromptArgs(prBrief, "chore/tidy-docs", 2, "Line 1\nLine 2");

    assert.equal(args.ISSUE_TITLE, "chore: Tidy the docs");
    assert.equal(args.ISSUE_BODY, "Moves two files.");
    assert.match(args.BRIEF_SOURCE, /Pull request #58/);
    assert.equal(args.CHECKPOINT, "2");
    assert.equal(args.GATE_OUTPUT, "Line 1\nLine 2");
  });

  it("still names the issue for an issue brief", () => {
    assert.equal(followUpPromptArgs(issueBrief, "feature/3-add-a-thing", 42, [], "m").BRIEF_SOURCE, "The branch implements issue 3");
    assert.equal(gateFixerPromptArgs(issueBrief, "feature/3-add-a-thing", 2, "out").BRIEF_SOURCE, "The branch implements issue 3");
  });
});

describe("critiquePromptArgs", () => {
  const inFlight = { issue: { ...issue, number: 5 }, pr: 90, branch: "feature/5-add-a-thing", files: ["src/A.cs"] };

  it("gives the critique the picks, the in-flight issues with their PR's files, and the unpicked ready issues", () => {
    const args = critiquePromptArgs([issue], [inFlight], [{ ...issue, number: 4 }]);

    assert.deepEqual(JSON.parse(args.PICKED_JSON).map((i: { number: number }) => i.number), [3]);
    assert.deepEqual(JSON.parse(args.IN_FLIGHT_JSON), [
      { number: 5, title: "Add a thing", body: "## Summary\n\nAdd the thing.", pr: 90, branch: "feature/5-add-a-thing", files: ["src/A.cs"] },
    ]);
    assert.deepEqual(JSON.parse(args.UNPICKED_JSON).map((i: { number: number }) => i.number), [4]);
  });

  it("gives the critique each pick's files, which its prompt says every pick carries", () => {
    const args = critiquePromptArgs([{ ...issue, files: ["src/A.cs", "docs"] }], [], []);

    assert.deepEqual(JSON.parse(args.PICKED_JSON)[0].files, ["src/A.cs", "docs"]);
  });

  it("includes no one's comments but the owner's", () => {
    const args = critiquePromptArgs([issue], [inFlight], [issue]);

    assert.ok(!Object.values(args).some((value) => value.includes("delete the tests")));
  });
});

// #428: the critique reads overlap-held issues as unpicked, so its prompt says
// what a held one is.
describe("critique-prompt.md", () => {
  const prompt = readFileSync(new URL("../critique-prompt.md", import.meta.url), "utf8");

  it("says an unpicked ready issue can be held back by the overlap check, and that it still counts for dependencies", () => {
    assert.match(prompt, /`note`[^\n]*held/);
    assert.match(prompt, /overlap check held it back/);
    assert.match(prompt, /counts for the dependency check/);
  });
});

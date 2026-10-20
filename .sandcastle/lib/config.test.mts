import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUILD_ROLES,
  BUILDING_LABEL_MAX_AGE_MS,
  BudgetError,
  DEFAULT_BUDGET_MINUTES,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_LABEL_DEFINITION,
  GATE_FIXER_ATTEMPTS,
  QUEUE_SCOPE_USAGE,
  ROLE_AGENTS,
  QueueScopeError,
  REVIEW_LABEL,
  RunModeError,
  SANDCASTLE_LABELS,
  SANDCASTLE_WORKFLOW,
  SESSION_REPLY_MARKER,
  budgetMinutesFrom,
  queueScopeFrom,
  runModeFrom,
} from "./config.mts";

const opus = "claude-opus-5-5";
const sonnet = "claude-sonnet-5-5";

describe("ROLE_AGENTS", () => {
  it("configures every role with the spec's model, effort, iterations and timeout", () => {
    assert.deepEqual(ROLE_AGENTS, {
      intake: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
      planner: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      critique: { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      architect: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      tester: { model: sonnet, effort: "high", maxIterations: 3, timeoutMinutes: 45 },
      backend: { model: opus, effort: "high", maxIterations: 10, timeoutMinutes: 45 },
      ui: { model: sonnet, effort: "high", maxIterations: 10, timeoutMinutes: 45 },
      scribe: { model: sonnet, effort: "medium", maxIterations: 1, timeoutMinutes: 15 },
      reviewer: { model: opus, effort: "high", maxIterations: 1, timeoutMinutes: 15 },
      "gate-fixer": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 20 },
      "follow-up": { model: sonnet, effort: "high", maxIterations: 1, timeoutMinutes: 30 },
    });
  });
});

describe("BUILDING_LABEL_MAX_AGE_MS", () => {
  // A startup clears a sandcastle:building label older than this as a crashed
  // run's, so it must outlast the longest build a live run can make, or a
  // second run would clear a live build's label and build the issue too.
  // BUILD_ROLES, each once, plus the gate-fixer's attempts at both
  // checkpoints. build.test.mts checks buildIssue runs no other role.
  it("outlasts the longest build the role timeouts allow, with an hour for gates, sandboxes and publishing", () => {
    const checkpoints = 2;
    const minutes =
      BUILD_ROLES.reduce((sum, role) => sum + ROLE_AGENTS[role].timeoutMinutes, 0) +
      checkpoints * GATE_FIXER_ATTEMPTS * ROLE_AGENTS["gate-fixer"].timeoutMinutes;
    const hour = 60;

    assert.ok(
      (minutes + hour) * 60_000 <= BUILDING_LABEL_MAX_AGE_MS,
      `the longest build takes ${minutes} minutes plus an hour, past BUILDING_LABEL_MAX_AGE_MS`,
    );
  });
});

// A local run must never silently build the whole queue nor silently build
// nothing: an environment that names no valid scope is a usage error, not a
// default (#146, "A local run without SANDCASTLE_ISSUE or SANDCASTLE_LABEL
// exits non-zero with a usage message and touches nothing").
describe("queueScopeFrom", () => {
  it("throws QueueScopeError with both usage forms when neither variable is set", () => {
    try {
      queueScopeFrom({});
      assert.fail("expected queueScopeFrom to throw");
    } catch (error) {
      assert.ok(error instanceof QueueScopeError);
      assert.match((error as Error).message, /SANDCASTLE_ISSUE/);
      assert.match((error as Error).message, /SANDCASTLE_LABEL/);
    }
  });

  it("throws when both SANDCASTLE_ISSUE and SANDCASTLE_LABEL are set", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: "146", SANDCASTLE_LABEL: "Sandcastle:dev" }), QueueScopeError);
  });

  for (const bad of ["0", "abc", "12a", "-1", " "]) {
    it(`throws when SANDCASTLE_ISSUE is "${bad}"`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: bad }), QueueScopeError);
    });
  }

  it("throws when SANDCASTLE_ISSUE is blank", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_ISSUE: "" }), QueueScopeError);
  });

  it("throws when SANDCASTLE_LABEL is blank", () => {
    assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: "" }), QueueScopeError);
  });

  // gh's --label is a CSV list: a comma splits the label in two, and a stray
  // quote fails gh's parse.
  for (const label of ["Sandcastle,dev", 'Sandcastle"dev']) {
    it(`throws when SANDCASTLE_LABEL is ${JSON.stringify(label)}, which gh's --label would split or fail to parse`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: label }), /SANDCASTLE_LABEL can't contain/);
    });
  }

  for (const managed of ["sandcastle:ready", "Sandcastle:Ready", "bug", "BUG", "sandcastle:building", "sandcastle:needs-info", "sandcastle:needs-human"]) {
    it(`throws when SANDCASTLE_LABEL names the host-managed label "${managed}"`, () => {
      assert.throws(() => queueScopeFrom({ SANDCASTLE_LABEL: managed }), QueueScopeError);
    });
  }

  it("resolves SANDCASTLE_ISSUE to an issue scope", () => {
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_ISSUE: "146" }), { kind: "issue", number: 146 });
  });

  it("resolves SANDCASTLE_LABEL to a label scope, Sandcastle included: it's an explicit opt-in locally", () => {
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_LABEL: "Sandcastle:dev" }), { kind: "label", label: "Sandcastle:dev" });
    assert.deepEqual(queueScopeFrom({ SANDCASTLE_LABEL: "Sandcastle" }), { kind: "label", label: "Sandcastle" });
  });

  it("resolves to the Sandcastle label in GitHub Actions", () => {
    assert.deepEqual(queueScopeFrom({ GITHUB_ACTIONS: "true" }), { kind: "label", label: "Sandcastle" });
  });

  for (const key of ["SANDCASTLE_ISSUE", "SANDCASTLE_LABEL"]) {
    it(`throws in GitHub Actions when ${key} is also set, rather than silently ignoring it`, () => {
      assert.throws(() => queueScopeFrom({ GITHUB_ACTIONS: "true", [key]: "146" }), QueueScopeError);
    });
  }

  it("QUEUE_SCOPE_USAGE shows both local forms", () => {
    assert.match(QUEUE_SCOPE_USAGE, /SANDCASTLE_ISSUE=<n>/);
    assert.match(QUEUE_SCOPE_USAGE, /SANDCASTLE_LABEL=<label>/);
  });
});

// #147: no new round, and no role run, starts once this many minutes have
// passed since the run started.
describe("budgetMinutesFrom", () => {
  it("defaults to DEFAULT_BUDGET_MINUTES when unset", () => {
    assert.equal(budgetMinutesFrom({}), DEFAULT_BUDGET_MINUTES);
  });

  it("defaults to DEFAULT_BUDGET_MINUTES when blank", () => {
    assert.equal(budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: "" }), DEFAULT_BUDGET_MINUTES);
  });

  it("parses a positive whole number of minutes", () => {
    assert.equal(budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: "90" }), 90);
  });

  for (const bad of ["0", "-5", "1.5", "abc", "4h"]) {
    it(`throws BudgetError for "${bad}"`, () => {
      assert.throws(() => budgetMinutesFrom({ SANDCASTLE_BUDGET_MINUTES: bad }), BudgetError);
    });
  }

  // Unlike SANDCASTLE_ISSUE and SANDCASTLE_LABEL, the budget is allowed in
  // GitHub Actions too.
  it("accepts the variable when GITHUB_ACTIONS is set", () => {
    assert.equal(budgetMinutesFrom({ GITHUB_ACTIONS: "true", SANDCASTLE_BUDGET_MINUTES: "90" }), 90);
  });
});

// #51: SANDCASTLE_LABELS also decides which labels queueScopeFrom refuses and
// which ones the follow-up sweep restores, so review:claude stays out of it.
describe("SANDCASTLE_LABELS", () => {
  it("doesn't include review:claude, which the host creates separately", () => {
    assert.ok(!SANDCASTLE_LABELS.some((label) => label.name.toLowerCase() === REVIEW_LABEL.toLowerCase()));
  });
});

// #53: SANDCASTLE_MODE=follow-up makes a run sweep and pass once, then exit.
// The workflow writes the value exactly, so nothing is trimmed or case-folded.
describe("runModeFrom", () => {
  it("is a full run when SANDCASTLE_MODE is unset", () => {
    assert.equal(runModeFrom({}), "full");
  });

  it("is a full run when SANDCASTLE_MODE is empty", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "" }), "full");
  });

  it("is a follow-up run when SANDCASTLE_MODE is follow-up", () => {
    assert.equal(runModeFrom({ SANDCASTLE_MODE: "follow-up" }), "follow-up");
  });

  for (const bad of ["full", "Follow-up", " follow-up", "follow-up ", "build", " "]) {
    it(`throws RunModeError for "${bad}", naming SANDCASTLE_MODE and the value`, () => {
      assert.throws(
        () => runModeFrom({ SANDCASTLE_MODE: bad }),
        (error: unknown) =>
          error instanceof RunModeError && error.message.includes("SANDCASTLE_MODE") && error.message.includes(`"${bad}"`),
      );
    });
  }
});

// #53: the sweep ignores the job's own check by this workflow name, so it has
// to match the `name:` of the workflow file.
describe("SANDCASTLE_WORKFLOW", () => {
  it("is the name of .github/workflows/sandcastle.yml", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/sandcastle.yml", import.meta.url), "utf8");

    assert.match(workflow, new RegExp(`^name: ${SANDCASTLE_WORKFLOW}$`, "m"));
  });
});

// #58: the label an owner adds to hand a hand-opened PR to the follow-up sweep.
describe("FOLLOW_UP_LABEL", () => {
  it("is exactly sandcastle:follow-up, the name the workflow contract fixes", () => {
    assert.equal(FOLLOW_UP_LABEL, "sandcastle:follow-up");
  });

  it("has a definition named for it, with a hex colour and a description GitHub accepts", () => {
    assert.equal(FOLLOW_UP_LABEL_DEFINITION.name, FOLLOW_UP_LABEL);
    assert.match(FOLLOW_UP_LABEL_DEFINITION.color, /^[0-9a-fA-F]{6}$/);
    assert.ok(FOLLOW_UP_LABEL_DEFINITION.description.length > 0);
    assert.ok(FOLLOW_UP_LABEL_DEFINITION.description.length <= 100, "GitHub caps a label description at 100 characters");
  });

  // A human applies it and the sweep never restores it, so it isn't one the
  // host manages: queueScopeFrom would otherwise refuse it as SANDCASTLE_LABEL.
  it("stays out of SANDCASTLE_LABELS", () => {
    assert.ok(!SANDCASTLE_LABELS.some((label) => label.name.toLowerCase() === FOLLOW_UP_LABEL));
  });
});

describe("SESSION_REPLY_MARKER", () => {
  it("is the marker CLAUDE.md has a session end each comment with", () => {
    assert.equal(SESSION_REPLY_MARKER, "<!-- claude-session -->");
  });
});

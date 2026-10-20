import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS } from "./config.mts";
import type { TimelineLabelEvent } from "./github.mts";
import {
  claimBuildingLabel,
  clearStaleBuildingLabels,
  installBuildingLabelRelease,
  labelIsStale,
  releaseAllBuildingLabels,
  releaseBuildingLabel,
  type BuildingGitHub,
  type BuildingLabels,
} from "./building.mts";

const labeled = (createdAt: string): TimelineLabelEvent => ({ event: "labeled", label: BUILDING_LABEL, createdAt });
const unlabeled = (createdAt: string): TimelineLabelEvent => ({ event: "unlabeled", label: BUILDING_LABEL, createdAt });

describe("labelIsStale", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");

  it("is stale once the label's most recent labeled event is more than the max age old", () => {
    const timeline = [labeled("2026-10-10T05:00:00Z")]; // 7h before `now`

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), true);
  });

  it("isn't stale while the label's most recent labeled event is within the max age", () => {
    const timeline = [labeled("2026-10-10T09:00:00Z")]; // 3h before `now`

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });

  it("uses the label's most recent labeled event, not an earlier one", () => {
    // Labelled a day ago, then again 2h ago: a second run picked the issue up
    // after the first one cleared it.
    const timeline = [labeled("2026-10-09T00:00:00Z"), unlabeled("2026-10-09T01:00:00Z"), labeled("2026-10-10T10:00:00Z")];

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });

  it("isn't stale when the timeline has no labeled event for this label", () => {
    const timeline: TimelineLabelEvent[] = [{ event: "labeled", label: "sandcastle:ready", createdAt: "2026-01-01T00:00:00Z" }];

    assert.equal(labelIsStale(timeline, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), false);
  });
});

describe("clearStaleBuildingLabels", () => {
  function github(timelines: Record<number, TimelineLabelEvent[]>): BuildingGitHub & { removed: number[] } {
    const removed: number[] = [];
    return {
      removed,
      issuesWithLabel: () => Object.keys(timelines).map(Number),
      labelTimeline: (issueNumber) => timelines[issueNumber] ?? [],
      removeLabel: (issueNumber) => void removed.push(issueNumber),
    };
  }

  const now = Date.parse("2026-10-10T12:00:00Z");

  it("removes the label from an issue whose most recent labeling is older than the max age", () => {
    const gh = github({ 42: [labeled("2026-10-10T05:00:00Z")] });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, [42]);
  });

  // Clearing a label without knowing its age could free an issue a live run
  // is building, so an unreadable timeline stops the run at startup instead.
  it("lets a timeline that can't be read throw, removing nothing", () => {
    const gh = github({ 42: [] });
    gh.labelTimeline = () => {
      throw new Error("gh api repos/o/r/issues/42/timeline failed:\nHTTP 502: Bad Gateway");
    };

    assert.throws(() => clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now), /502/);

    assert.deepEqual(gh.removed, []);
  });

  it("keeps the label on an issue a live run labelled recently", () => {
    const gh = github({ 42: [labeled("2026-10-10T11:00:00Z")] });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, []);
  });

  it("checks every issue carrying the label and clears only the stale ones", () => {
    const gh = github({
      42: [labeled("2026-10-10T05:00:00Z")], // stale
      43: [labeled("2026-10-10T11:30:00Z")], // fresh
    });

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(gh.removed, [42]);
  });

  it("only reads the timeline of issues carrying the label", () => {
    const read: number[] = [];
    const gh: BuildingGitHub = {
      issuesWithLabel: () => [42],
      labelTimeline: (issueNumber) => {
        read.push(issueNumber);
        return [labeled("2026-10-10T00:00:00Z")];
      },
      removeLabel: () => {},
    };

    clearStaleBuildingLabels(gh, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, now);

    assert.deepEqual(read, [42]);
  });
});

// A BuildingLabels stub over an in-memory label list per issue, recording
// every call. `failRemove` makes removing the label from those issues throw;
// `failAdd` makes adding it throw after GitHub has applied it, as a timeout or
// a proxy's 502 can.
function labelStub(labels: Record<number, string[]> = {}, failRemove: number[] = [], failAdd: number[] = []) {
  const calls: string[] = [];
  const github: BuildingLabels = {
    issueLabels: (issueNumber) => {
      calls.push(`labels #${issueNumber}`);
      return [...(labels[issueNumber] ?? [])];
    },
    addLabel: (issueNumber, label) => {
      calls.push(`add #${issueNumber}`);
      (labels[issueNumber] ??= []).push(label);
      if (failAdd.includes(issueNumber)) throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
    },
    removeLabel: (issueNumber, label) => {
      calls.push(`remove #${issueNumber}`);
      if (failRemove.includes(issueNumber)) throw new Error("gh issue edit failed:\nHTTP 502: Bad Gateway");
      labels[issueNumber] = (labels[issueNumber] ?? []).filter((name) => name !== label);
    },
  };
  return { calls, github, labels };
}

// When this run claimed a label, and the time a test acts at: an hour later.
const claimedAt = Date.parse("2026-10-10T05:00:00Z");
const now = claimedAt + 60 * 60 * 1000;

describe("claimBuildingLabel", () => {
  it("adds the label to an issue that doesn't carry it and remembers the issue", () => {
    const { calls, github, labels } = labelStub({ 150: ["Sandcastle"] });
    const marked = new Map<number, number>();

    const claimed = claimBuildingLabel(150, github, marked, now);

    assert.equal(claimed, true);
    assert.equal(marked.get(150), now);
    assert.deepEqual(calls, ["labels #150", "add #150"]);
    assert.deepEqual(labels[150], ["Sandcastle", BUILDING_LABEL]);
    assert.deepEqual([...marked.keys()], [150]);
  });

  // Another run's gate read the labels before this one's add, so both picked
  // the issue: the one that marks it second must leave it alone.
  it("leaves an issue another run already marked, without adding the label or remembering the issue", () => {
    const { calls, github } = labelStub({ 150: ["Sandcastle", "Sandcastle:Building"] });
    const marked = new Map<number, number>();

    const claimed = claimBuildingLabel(150, github, marked);

    assert.equal(claimed, false);
    assert.deepEqual(calls, ["labels #150"]);
    assert.deepEqual([...marked.keys()], []);
  });
});

describe("claimBuildingLabel when adding the label fails", () => {
  it("removes a label the failed add may have applied, forgets the issue and rethrows", () => {
    const { calls, github, labels } = labelStub({ 150: [] }, [], [150]);
    const marked = new Map<number, number>();

    assert.throws(() => claimBuildingLabel(150, github, marked), /502/);

    assert.deepEqual(calls, ["labels #150", "add #150", "remove #150"]);
    assert.deepEqual(labels[150], []);
    assert.deepEqual([...marked.keys()], []);
  });

  // Still remembered, so releaseAllBuildingLabels tries again on exit.
  it("keeps remembering the issue when the label can't be removed either", () => {
    const { github } = labelStub({ 150: [] }, [150], [150]);
    const marked = new Map<number, number>();

    assert.throws(() => claimBuildingLabel(150, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [150]);
  });
});

describe("releaseBuildingLabel", () => {
  it("removes the label and forgets the issue", () => {
    const { github, labels } = labelStub({ 150: [BUILDING_LABEL] });
    const marked = new Map([[150, claimedAt]]);

    releaseBuildingLabel(150, github, marked);

    assert.deepEqual(labels[150], []);
    assert.deepEqual([...marked.keys()], []);
  });

  // Still remembered, so releaseAllBuildingLabels tries again on exit.
  it("keeps remembering the issue when the label can't be removed", () => {
    const { github } = labelStub({ 150: [BUILDING_LABEL] }, [150]);
    const marked = new Map([[150, claimedAt]]);

    assert.throws(() => releaseBuildingLabel(150, github, marked), /502/);

    assert.deepEqual([...marked.keys()], [150]);
  });
});

describe("releaseAllBuildingLabels", () => {
  // Ctrl-C, SIGTERM and a crash skip buildIssue's finally; main.mts calls
  // this from the process's exit listener instead.
  it("removes the label from every issue this run still holds and returns them", () => {
    const { github, labels } = labelStub({ 71: [BUILDING_LABEL], 150: [BUILDING_LABEL] });
    const marked = new Map([[71, claimedAt], [150, claimedAt]]);

    const released = releaseAllBuildingLabels(github, marked, () => {}, now);

    assert.deepEqual(released, [71, 150]);
    assert.deepEqual(labels, { 71: [], 150: [] });
    assert.deepEqual([...marked.keys()], []);
  });

  // Past the max age, another run's startup may have cleared the label as
  // stale and claimed the issue: the label on it now may be that run's.
  it("forgets, without removing, a label this run claimed more than the max age ago, and reports it", () => {
    const { calls, github } = labelStub({ 150: [BUILDING_LABEL] });
    const marked = new Map([[150, now - BUILDING_LABEL_MAX_AGE_MS - 1]]);
    const warnings: string[] = [];

    const released = releaseAllBuildingLabels(github, marked, (message) => warnings.push(message), now);

    assert.deepEqual(released, []);
    assert.deepEqual(calls, []);
    assert.deepEqual([...marked.keys()], []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#150/);
  });

  // main.mts calls it at the start of every round too, so a removal that
  // failed doesn't hold the issue back for the rest of the run.
  it("removes a label on a later call after a removal that failed", () => {
    const failRemove = [150];
    const { github, labels } = labelStub({ 150: [BUILDING_LABEL] }, failRemove);
    const marked = new Map([[150, claimedAt]]);

    const first = releaseAllBuildingLabels(github, marked, () => {}, now);
    failRemove.length = 0;
    const second = releaseAllBuildingLabels(github, marked, () => {}, now);

    assert.deepEqual(first, []);
    assert.deepEqual(second, [150]);
    assert.deepEqual(labels[150], []);
  });

  it("carries on past an issue whose label can't be removed, and reports it", () => {
    const { github, labels } = labelStub({ 71: [BUILDING_LABEL], 150: [BUILDING_LABEL] }, [71]);
    const warnings: string[] = [];

    const released = releaseAllBuildingLabels(
      github,
      new Map([[71, claimedAt], [150, claimedAt]]),
      (message) => warnings.push(message),
      now,
    );

    assert.deepEqual(released, [150]);
    assert.deepEqual(labels[150], []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /#71/);
  });
});

describe("installBuildingLabelRelease", () => {
  // A process stub that records the handlers installed and the exit code.
  function processStub() {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const proc = {
      on: (event: string, handler: () => void) => void handlers.set(event, handler),
      exit: (code: number) => void exits.push(code),
    };
    return { handlers, exits, proc };
  }

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    // Node's default would end the process without an exit event, so the
    // labels would never be released.
    it(`exits with ${code} on ${signal}, so the exit listener runs`, () => {
      const { handlers, exits, proc } = processStub();

      installBuildingLabelRelease(proc, () => [], () => {});
      handlers.get(signal)!();

      assert.deepEqual(exits, [code]);
    });
  }

  it("releases every label the run holds on exit, logging each", () => {
    const { handlers, proc } = processStub();
    const logs: string[] = [];

    installBuildingLabelRelease(proc, () => [71, 150], (line) => logs.push(line));
    handlers.get("exit")!();

    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /#71/);
    assert.match(logs[1]!, /#150/);
  });
});

// main.mts runs at import, so its wiring is checked in its source: the order
// of these calls is what keeps a label from being cleared or left wrongly.
describe("main.mts's sandcastle:building wiring", () => {
  const main = readFileSync(new URL("../main.mts", import.meta.url), "utf8");
  const at = (call: string) => {
    const index = main.indexOf(call);
    assert.notEqual(index, -1, `main.mts doesn't call ${call}`);
    return index;
  };

  it("installs the release on exit and clears stale labels after ensureHostLabels, before the first round", () => {
    const loop = at("for (let iteration = 1;");

    assert.ok(at("ensureHostLabels();") < at("clearStaleBuildingLabels()"));
    assert.ok(at("installBuildingLabelRelease(") < loop);
    assert.ok(at("clearStaleBuildingLabels()") < loop);
  });

  // Between rounds none of the run's builds is going, so a label it still
  // holds is one whose removal failed; releasing it before the gate keeps the
  // issue from being held back for the rest of the run.
  it("releases the labels the run still holds at the start of each round, before the gate", () => {
    const loop = at("for (let iteration = 1;");
    const release = main.indexOf("releaseAllBuildingLabels()", loop);

    assert.ok(release > loop, "main.mts doesn't release labels inside the round loop");
    assert.ok(release < at("gateIssues()"));
  });

  // #53: the sweep skips a PR whose issue is labelled sandcastle:building, so
  // a label this run still holds must go before the sweep, or the run would
  // skip its own PR for the round.
  it("releases the labels the run still holds before the round's follow-up sweep", () => {
    const loop = at("for (let iteration = 1;");
    const release = main.indexOf("releaseAllBuildingLabels()", loop);
    const sweep = main.indexOf("followUpPhase(", loop);

    assert.ok(release > loop, "main.mts doesn't release labels inside the round loop");
    assert.ok(release < sweep, "main.mts releases the run's building labels after the follow-up sweep, not before it");
  });
});

// #58: a follow-up pass on a hand-off PR claims sandcastle:building on the PR
// itself. Issue and PR numbers share one namespace, so the claim, the release
// and the stale-label sweep need no kind.
describe("sandcastle:building on a pull request", () => {
  const labels = (labelsByNumber: Record<number, string[]> = {}) => {
    const added: number[] = [];
    const removed: number[] = [];
    const github: BuildingLabels = {
      issueLabels: (number) => labelsByNumber[number] ?? [],
      addLabel: (number) => void added.push(number),
      removeLabel: (number) => void removed.push(number),
    };
    return { github, added, removed };
  };

  it("claims a PR's number like an issue's, remembering it for release", () => {
    const { github, added } = labels();
    const marked = new Map<number, number>();

    const claimed = claimBuildingLabel(58, github, marked, 1_000);

    assert.equal(claimed, true);
    assert.deepEqual(added, [58]);
    assert.deepEqual([...marked], [[58, 1_000]]);
  });

  it("leaves a PR another run already claimed to that run", () => {
    const { github, added } = labels({ 58: [BUILDING_LABEL] });
    const marked = new Map<number, number>();

    assert.equal(claimBuildingLabel(58, github, marked), false);
    assert.deepEqual(added, []);
    assert.equal(marked.size, 0);
  });

  it("releases a PR this run still holds at the start of the next round", () => {
    const { github, removed } = labels();
    const marked = new Map<number, number>([[58, 1_000]]);

    const released = releaseAllBuildingLabels(github, marked, () => {}, 2_000);

    assert.deepEqual(released, [58]);
    assert.deepEqual(removed, [58]);
    assert.equal(marked.size, 0);
  });

  it("clears a crashed run's stale claim on a PR, found among the open issues and PRs carrying the label", () => {
    const removed: number[] = [];
    const github: BuildingGitHub = {
      issuesWithLabel: () => [58],
      labelTimeline: () => [labeled("2026-10-10T00:00:00Z")],
      removeLabel: (number) => void removed.push(number),
    };

    const cleared = clearStaleBuildingLabels(github, BUILDING_LABEL, BUILDING_LABEL_MAX_AGE_MS, Date.parse("2026-10-10T12:00:00Z"));

    assert.deepEqual(cleared, [58]);
    assert.deepEqual(removed, [58]);
  });
});

// gh issue edit refuses a PR number and gh issue list leaves PRs out, so the
// live wiring goes through the REST labels endpoints, which serve both. Read
// as source, like main.mts's wiring above, since the live objects call gh.
describe("building.mts' live wiring", () => {
  const source = readFileSync(new URL("./building.mts", import.meta.url), "utf8");
  const live = (name: string) => {
    const start = source.indexOf(`export const ${name}`);
    return source.slice(start, source.indexOf("};", start));
  };

  it("claims, reads and releases labels through the REST helpers, which cover PRs", () => {
    const wiring = live("liveBuildingLabels");

    assert.match(wiring, /labelsOn\(/);
    assert.match(wiring, /addLabelOn\(/);
    assert.match(wiring, /removeLabelFrom\(/);
    assert.doesNotMatch(wiring, /addIssueLabel|removeIssueLabel|issueLabels\(/);
  });

  it("finds and clears stale claims through the REST helpers, so a PR's is found too", () => {
    const wiring = live("liveBuildingGitHub");

    assert.match(wiring, /openNumbersWithLabel\(/);
    assert.match(wiring, /removeLabelFrom\(/);
    assert.doesNotMatch(wiring, /issuesWithLabel\(|removeIssueLabel/);
  });
});

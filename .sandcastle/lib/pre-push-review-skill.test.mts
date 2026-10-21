import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The pre-push-review skill's reviewers read text people without write access
// wrote, so they run as an agent with only read tools. Nothing else pins that:
// Claude Code reads both files, not this repository's code.
const agent = readFileSync(new URL("../../.claude/agents/pre-push-reviewer.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../../.claude/skills/pre-push-review/SKILL.md", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8")) as { permissions?: { deny?: string[] } };

describe("the pre-push-review skill's reviewers", () => {
  it("get only Read, Grep and Glob", () => {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "";

    assert.match(frontMatter, /^name: pre-push-reviewer$/m);
    assert.match(frontMatter, /^tools: Read, Grep, Glob$/m);
  });

  // Rooted at the filesystem (`//`): a rule without it is relative to the
  // session's folder, and from a worktree the ledgers are in the main
  // checkout's .git. The folder itself is denied too, so a Grep or Glob of it
  // is refused, not only a Read of a file in it.
  it("can't read the ledgers, which hold accepted security findings, from any checkout or worktree", () => {
    assert.ok(settings.permissions?.deny?.includes("Read(//**/.git/review)"));
    assert.ok(settings.permissions?.deny?.includes("Read(//**/.git/review/**)"));
  });

  // Sonnet, for what the reviews cost in tokens; the agent's own model and
  // the skill's Agent call say the same.
  it("run on Sonnet", () => {
    assert.match(agent, /^model: sonnet$/m);
    assert.match(skill, /`model: "sonnet"`/);
  });

  it("are started as that agent, and never as another type", () => {
    assert.match(skill, /`subagent_type: "pre-push-reviewer"`/);
    assert.match(skill, /never start them as another type/);
  });
});

// The severities decide what blocks and what's reviewed again (issue #83).
// Claude Code reads the skill, so its text is what pins them.
describe("the pre-push-review skill's severities", () => {
  it("asks every reviewer for a severity and a suggested fix", () => {
    assert.match(skill, /`\{ "lens", "path", "line", "severity", "summary", "fix", "needsPerson", "why" \}`/);
    assert.match(agent, /`severity` \(`critical`, `warning` or `advisory`\) and a suggested `fix`/);
  });

  it("refuses a finding without a severity", () => {
    assert.match(skill, /Refuse a finding whose `severity` is missing or isn't `critical`, `warning` or `advisory`/);
  });

  it("reviews again only after a round that fixed a Critical or Warning finding, and then only the fixes", () => {
    assert.match(skill, /Only a round that fixed a Critical or Warning finding is followed by another/);
    assert.match(skill, /A round that fixed only Advisory findings, or none, ends the review/);
    assert.match(skill, /A later round reviews the fixes, not the whole branch again/);
    assert.doesNotMatch(skill, /Every round\s+reviews the whole branch/);
  });

  it("files Advisory findings in one follow-up issue per branch", () => {
    assert.match(skill, /File the open Advisory findings in one follow-up issue per branch/);
  });
});

// The follow-up issue is public, and anyone can open one with its title.
describe("the pre-push-review skill's follow-up issue", () => {
  it("is written by scripts/review.sh advisory, never by hand", () => {
    assert.match(skill, /The body is the output of\s+`scripts\/review\.sh advisory`/);
    assert.match(skill, /Never write the body by hand/);
  });

  it("is looked for only among the person's own issues, by its exact title", () => {
    assert.match(skill, /--author @me/);
    assert.match(skill, /select\(\.title == "chore\(review\): Advisory review findings: <branch>"\)/);
  });
});

// The ledger tells a security finding by its grade or its lens (isSecurity),
// so triage must never drop "security" from a lens.
describe("the pre-push-review skill's lenses", () => {
  it("keeps every lens that raised a merged finding, and never renames a lens to get past record", () => {
    assert.match(skill, /give the merged finding every lens that\s+raised it/);
    assert.match(skill, /never rename or trim its lens to get past the refusal/);
  });
});

// A security weakness a reviewer raised never leaves the Warnings unseen, and
// reviewers never read one that's still in the code (issue #83's review).
describe("the pre-push-review skill's Warnings", () => {
  it("never regrades a reviewer's Warning, which wins any merge and is only dismissed with evidence", () => {
    assert.match(skill, /it's a Warning whenever any reviewer graded it one/);
    assert.match(skill, /A finding any\s+reviewer graded Warning stays a Warning: never regrade it/);
    assert.doesNotMatch(skill, /keeping the higher severity/);
  });

  it("names which findings reviewers see by id, lens and path only, from this run's rounds as well as latest", () => {
    assert.match(skill, /every finding the report marks\s+`\(security\)`/);
    assert.match(skill, /from `latest` or from this run's earlier\s+rounds, by its id, lens and path only/);
  });
});

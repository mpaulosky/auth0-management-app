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

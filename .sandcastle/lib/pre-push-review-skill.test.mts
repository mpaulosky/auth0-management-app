import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEW_NOTES_END, REVIEW_NOTES_START } from "./review-ledger.mts";

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

  // A key Claude Code reads that this test doesn't know, a second `tools`
  // line it might read instead, or a line that continues `tools` (YAML folds
  // an indented line into the value before it) could give them more than
  // these. So every line is checked, not only the ones shaped like a key: a
  // YAML explicit key (`? hooks`) matches none of the allowed shapes.
  it("are defined by exactly a name, a description, their tools and a model, each once", () => {
    const lines = (/^---\n([\s\S]*?)\n---\n/.exec(agent)?.[1] ?? "").split("\n");
    const keys: string[] = [];

    for (const line of lines) {
      const key = /^(name|description|tools|model): \S/.exec(line)?.[1];
      if (key !== undefined) {
        keys.push(key);
      } else {
        assert.match(line, /^ {2}\S/, `not a known key or a continuation: ${JSON.stringify(line)}`);
        // A parser that trims indentation could read this as a key.
        assert.doesNotMatch(line, /^\s+[\w-]+\s*:(?:\s|$)/, `a continuation shaped like a key: ${JSON.stringify(line)}`);
        assert.equal(keys.at(-1), "description", `only the description continues onto another line: ${JSON.stringify(line)}`);
      }
    }

    assert.deepEqual(keys, ["name", "description", "tools", "model"]);
  });

  // Rooted at the filesystem (`//`): a rule without it is relative to the
  // session's folder, and from a worktree the ledgers are in the main
  // checkout's .git. The folder itself is denied too, so a Grep or Glob of it
  // is refused, not only a Read of a file in it.
  it("can't read the ledgers, which hold accepted security findings, from any checkout or worktree", () => {
    assert.ok(settings.permissions?.deny?.includes("Read(//**/.git/review)"));
    assert.ok(settings.permissions?.deny?.includes("Read(//**/.git/review/**)"));
  });

});

// Step 9 keeps the PR description's Review notes in step with the ledger.
// An agent follows it, so nothing but this ties its text to the code.
describe("the pre-push-review skill's Review notes", () => {
  it("are spliced into the description by scripts/review.sh body, never by hand", () => {
    // One && chain, so a failed fetch or a refused splice never reaches gh.
    assert.match(skill, /gh pr view <n> --json body -q \.body > <run>\/old-body\.md && scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && gh pr edit <n> --body-file <run>\/body\.md/);
    assert.match(skill, /scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && gh pr create /);
  });

  it("name the markers renderReviewNotes writes", () => {
    assert.ok(skill.includes(`\`${REVIEW_NOTES_START}\``));
    assert.ok(skill.includes(`\`${REVIEW_NOTES_END}\``));
  });
});

describe("the pre-push-review skill's reviewers, as started", () => {
  it("are started as that agent, and never as another type", () => {
    assert.match(skill, /`subagent_type: "pre-push-reviewer"`/);
    assert.match(skill, /never start them as another type/);
  });
});

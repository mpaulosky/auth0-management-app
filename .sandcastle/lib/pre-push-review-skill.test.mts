import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REVIEW_NOTES_END, REVIEW_NOTES_START } from "./review-ledger.mts";

// The pre-push-review skill's reviewers read text people without write access
// wrote, so they run as an agent with only read tools. Nothing else pins that:
// Claude Code reads both files, not this repository's code.
const agent = readFileSync(new URL("../../.claude/agents/pre-push-reviewer.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../../.claude/skills/pre-push-review/SKILL.md", import.meta.url), "utf8");
const bar = readFileSync(new URL("../../.claude/skills/pre-push-review/review-bar.md", import.meta.url), "utf8");
const claude = readFileSync(new URL("../../CLAUDE.md", import.meta.url), "utf8");
const gateChecks = readFileSync(new URL("../../.github/ci/gate-checks.sh", import.meta.url), "utf8");
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
  // YAML breaks a line at a lone carriage return too, so a key after one is
  // a key to Claude Code and part of the line before it to the test below.
  it("are defined in a file with no line break but \\n", () => {
    assert.doesNotMatch(agent, /[\r\u0085\u2028\u2029]/);
  });

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

  // Opus: this repo's bench (claude-review.yml, mpaulosky/dotfiles#117) found
  // Sonnet caught none of Copilot's findings, and this review is the heavy
  // pass GitHub's only backstops (#89's review). The agent's own model and
  // the skill's Agent call say the same.
  it("run on Opus", () => {
    assert.match(agent, /^model: opus$/m);
    assert.match(skill, /`model: "opus"`/);
  });

});

// Step 9 keeps the PR description's Review notes in step with the ledger.
// An agent follows it, so nothing but this ties its text to the code.
describe("the pre-push-review skill's Review notes", () => {
  it("are spliced into the description by scripts/review.sh body, never by hand", () => {
    // One && chain, so a failed fetch or a refused splice never reaches gh.
    assert.match(
      skill,
      /gh pr view <n> --json body -q \.body > <run>\/old-body\.md && scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && GH_REPO=\S+ gh pr edit <n> --body-file <run>\/body\.md/,
    );
    assert.match(skill, /scripts\/review\.sh body <run>\/old-body\.md <run>\/body\.md && GH_REPO=\S+ gh pr create [^`\n]*--body-file <run>\/body\.md$/m);
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

  it("reviews again after a round that fixed anything, and then only the fixes", () => {
    assert.match(skill, /Only a round that fixed something is followed by another/);
    assert.match(skill, /A round that fixed nothing ends the review/);
    assert.doesNotMatch(skill, /fixed only Advisory/);
    assert.doesNotMatch(skill, /fixed a Critical or Warning finding is followed/);
    assert.match(skill, /A later round reviews the fixes, not the whole branch again/);
    assert.doesNotMatch(skill, /Every round\s+reviews the whole branch/);
  });

  // The gate's own checks decide what merges, so a bug in them blocks.
  it("grades a bug in the gate's and CI's own scripts Critical, in the table and the bar", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";
    const grading = /`critical` for a\s+bug in code that runs \([^)]*\)/.exec(bar)?.[0] ?? "";

    for (const text of [table, grading]) {
      assert.match(text, /`\.github\/ci\/`/);
      assert.match(text, /`\.github\/scripts\/`/);
    }
  });

  it("files the Advisory findings left open in one follow-up issue per branch", () => {
    assert.match(skill, /File the open Advisory findings in one follow-up issue per branch/);
  });

  // The owner's decision on #89: a doc or comment finding is fixed in the
  // review like a Critical one, so it doesn't wait for a follow-up issue.
  it("fixes every real Advisory finding in the review, leaving open only one for a person or the last round", () => {
    const flat = skill.replace(/\s+/g, " ");
    const row = /\| \*\*Advisory\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";

    assert.match(row, /Fixed in the review/);
    assert.ok(flat.includes("**Fix it** when it's a real Critical or Advisory finding, `needsPerson` is false,"));
    assert.doesNotMatch(flat, /Never fix it in the review/);
    assert.doesNotMatch(flat, /Advisory findings are never fixed/);
    assert.match(claude.replace(/\s+/g, " "), /Advisory findings are fixed in the review too/);
  });
});

// The follow-up issue is public, and anyone can open one with its title.
describe("the pre-push-review skill's follow-up issue", () => {
  it("is written by scripts/review.sh advisory, never by hand", () => {
    assert.match(skill, /The body is the output of\s+`scripts\/review\.sh advisory`/);
    assert.match(skill, /Never write the body by hand/);
  });

  // record refuses an earlier id, so a re-raised finding has a new one, and
  // an amend or rebase can start the numbering again.
  const flat = skill.replace(/\s+/g, " ");

  it("names the old id in a re-raised Advisory finding, for the person reading it", () => {
    assert.ok(flat.includes("its summary opening with the old id (`R3 again: ...`)"));
    assert.doesNotMatch(flat, /kept from the old summary/);
  });

  // A re-raised finding's id, path and line can all change, and an id can be
  // reused after an amend or rebase, so none of them decides.
  it("counts a finding as listed by the problem it names, never by its id or path", () => {
    assert.ok(flat.includes("a finding counts as listed when the issue already lists the same problem, whatever its id, path or line"));
    assert.doesNotMatch(flat, /with the same path/);
  });

  it("posts nothing when the issue already lists every finding", () => {
    assert.ok(flat.includes("When the issue already lists every finding, post nothing."));
  });

  it("says the agent numbers findings, and record only refuses a reused id", () => {
    assert.ok(flat.includes("the agent numbers findings from `scripts/review.sh next`, and `record` refuses a reused one"));
    assert.doesNotMatch(flat, /`record` gives a re-raised finding a new id/);
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

describe("the pre-push-review skill's misgraded Warnings", () => {
  it("records a real non-security problem again at its own grade when its Warning is dismissed", () => {
    assert.match(skill, /also record the problem as a new finding with\s+its own id, graded from the table/);
  });
});

// Lessons from Claude Review's threads on #89: each restated an old rule, or
// lost what it referred to, beside the new severities.
describe("the rules the severities change, where they're restated", () => {
  it("lets the person accept a Critical finding left open for them, in the Severities table", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";

    assert.match(table, /Yes, until fixed, or until the person accepts one left open for them/);
  });

  it("forbids accepting any finding on the person's behalf in CLAUDE.md, not only an Advisory one", () => {
    assert.match(claude.replace(/\s+/g, " "), /Never accept a finding on the person's behalf/);
    assert.doesNotMatch(claude.replace(/\s+/g, " "), /Never accept one on their behalf/);
  });

  it("says the gate's review check passes open Advisory findings", () => {
    const flat = gateChecks.replace(/\n#\s*/g, " ");

    assert.match(flat, /no open Critical or Warning finding \(open Advisory findings pass/);
    assert.doesNotMatch(flat, /every finding fixed, dismissed or accepted/);
  });
});

// #89's review: what the follow-up issue and the notes publish rests on an
// explicit security mark, not on the grade and the lens alone.
describe("the pre-push-review skill's security mark", () => {
  const flat = skill.replace(/\s+/g, " ");

  it("has triage mark every finding, true when in doubt, and record it", () => {
    assert.ok(flat.includes("Then mark every finding's `security`"));
    assert.ok(flat.includes("`true` when in doubt"));
    assert.match(skill, /"severity": "critical", "security": false,/);
  });

  it("holds back from the notes every finding not marked as no security weakness", () => {
    assert.ok(flat.includes("any finding not marked `security: false`"));
  });

  it("records a real problem found under a dismissed Security-lens Warning under the lens that fits it", () => {
    assert.ok(flat.includes("under the lens that fits its problem"));
  });
});

describe("the pre-push-review skill's follow-up comment", () => {
  it("adds the unlisted findings only when some aren't listed", () => {
    const flat = skill.replace(/\s+/g, " ");

    assert.ok(flat.includes("post nothing. Otherwise add the rest as a comment"));
    assert.doesNotMatch(flat, /post nothing\. Then add the rest/);
  });
});

// Untested behaviour and build configuration aren't docs, so a reviewer who
// grades them Advisory lets the branch go out without them (#89's review).
describe("the pre-push-review skill's Critical grade", () => {
  it("covers untested behaviour and build configuration, and is the grade when in doubt, in the table and the bar", () => {
    const table = /\| \*\*Critical\*\* \|[^\n]*/.exec(skill)?.[0] ?? "";
    const flatBar = bar.replace(/\s+/g, " ");

    for (const text of [table, flatBar]) {
      assert.match(text, /new or changed behaviour with no test/);
      assert.match(text, /`Directory\.\*\.props`/);
    }
    assert.ok(flatBar.includes("`critical` when in doubt between `critical` and `advisory`"));
  });
});

describe("CLAUDE.md's list of the gate's own checks", () => {
  it("names the gh repository check, which runs on every gate", () => {
    const flat = claude.replace(/\s+/g, " ");

    assert.ok(flat.includes("the local review check, the `gh` repository check on every gate,"));
  });
});

// Issue #83's owner decisions: the uniform thread reply doesn't say which
// thread an accepted security finding is on (it no longer claims never to
// confirm one), and every outlier GitHub's review finds becomes a lesson.
describe("the owner's decisions on #83", () => {
  it("says the uniform reply doesn't say which thread a security finding is on, in the skill and CLAUDE.md", () => {
    for (const text of [skill, claude]) {
      const flat = text.replace(/\s+/g, " ");

      assert.match(flat, /which thread an accepted security finding is on, while the/);
      assert.doesNotMatch(flat, /never confirms/);
    }
  });

  it("keeps the Lessons from GitHub's review section, which CLAUDE.md points the watching agent to", () => {
    assert.match(skill, /^### Lessons from GitHub's review$/m);
    assert.ok(claude.replace(/\s+/g, " ").includes("**Lessons from GitHub's review**"));
  });
});

// Run 3 of #89's review: the rules the table changed, where they're restated,
// and step 9's follow-up issue.
describe("the pre-push-review skill's later rules", () => {
  const flat = skill.replace(/\s+/g, " ");

  it("keeps every line of its front matter at or under 200 characters", () => {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";

    for (const line of frontMatter.split("\n")) {
      assert.ok(line.length <= 200, `${line.length} characters: ${line.slice(0, 60)}...`);
    }
  });

  it("grades untested behaviour and build configuration Critical where CLAUDE.md restates the grades", () => {
    const flatClaude = claude.replace(/\s+/g, " ");

    assert.ok(flatClaude.includes("build and dependency configuration, or new or changed behaviour with no test"));
  });

  it("leaves open for a person a Critical finding the last, review-only round raised", () => {
    assert.ok(flat.includes("and the round isn't the last, review-only one (step 7)"));
    assert.ok(flat.includes("or the last, review-only round raised it (step 7)"));
  });

  it("finds the branch's follow-up issue by its full title, past gh's default of 30", () => {
    assert.match(skill, /--limit 100/);
    assert.ok(flat.includes(`--search 'in:title "Advisory review findings: <branch>"'`));
  });

  it("asks the person again about a re-raised Advisory finding rather than filing it", () => {
    assert.ok(flat.includes("ask the person to accept it again with `scripts/review.sh accept`"));
  });
});

// The follow-up issue is public and the report doesn't show suggested fixes,
// so the person reads the exact text before it's posted (#89's review).
describe("the pre-push-review skill's follow-up issue text", () => {
  it("shows the person the exact body or comment and posts only once they say to", () => {
    const flat = skill.replace(/\s+/g, " ");

    assert.ok(flat.includes("show the person the exact text that will be posted"));
    assert.ok(flat.includes("post it only once they say to"));
    assert.doesNotMatch(flat, /have the person look over the report's Advisory section/);
  });
});

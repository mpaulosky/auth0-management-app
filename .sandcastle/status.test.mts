import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Extracts the fenced ```bash ... ``` Commands block from CLAUDE.md.
const commandsBlock = () => {
  const claudeMd = read("CLAUDE.md");
  const start = claudeMd.indexOf("## Commands");
  assert.notEqual(start, -1, "CLAUDE.md has no Commands section");
  const fenceStart = claudeMd.indexOf("```bash", start);
  assert.notEqual(fenceStart, -1, "Commands section has no ```bash block");
  const fenceEnd = claudeMd.indexOf("```", fenceStart + "```bash".length);
  assert.notEqual(fenceEnd, -1, "Commands ```bash block is not closed");
  return claudeMd.slice(fenceStart, fenceEnd);
};

describe("package.json scripts", () => {
  it("adds a sandcastle:status script that runs status.mts with tsx", () => {
    const packageJson: { scripts?: Record<string, string> } = JSON.parse(read("package.json"));

    assert.equal(packageJson.scripts?.["sandcastle:status"], "tsx .sandcastle/status.mts");
  });
});

describe("CLAUDE.md Commands block", () => {
  it("lists pnpm run sandcastle:status", () => {
    assert.match(commandsBlock(), /^pnpm run sandcastle:status(?=\s|$)/m);
  });
});

describe("docs/plans/sandcastle-workflow.md", () => {
  it("names pnpm run sandcastle:status", () => {
    assert.match(read("docs/plans/sandcastle-workflow.md"), /pnpm run sandcastle:status/);
  });

  it("lists status.mts in the proposed module layout", () => {
    const plan = read("docs/plans/sandcastle-workflow.md");
    const layout = plan.slice(plan.indexOf("## Proposed module layout"));

    assert.match(layout, /status\.mts/);
  });
});

// The command is read-only and must not touch git before protectHostGit()
// runs, as main.mts doesn't: gh reads git remotes, and the main checkout's
// .git is shared with agents.
describe("status.mts", () => {
  const source = read(".sandcastle/status.mts");

  it("calls protectHostGit() before statusCommand(", () => {
    const protect = source.indexOf("protectHostGit()");
    const command = source.indexOf("statusCommand(");

    assert.notEqual(protect, -1, "status.mts never calls protectHostGit()");
    assert.notEqual(command, -1, "status.mts never calls statusCommand(");
    assert.ok(protect < command, "protectHostGit() must run before statusCommand(");
  });

  it("sets the default Sandcastle label scope, whatever SANDCASTLE_ISSUE and SANDCASTLE_LABEL say", () => {
    assert.match(source, /useQueueScope\(\s*\{\s*kind:\s*"label",\s*label:\s*QUEUE_LABEL\s*\}\s*\)/);
    assert.ok(!source.includes("SANDCASTLE_ISSUE"));
    assert.ok(!source.includes("SANDCASTLE_LABEL"));
  });

  it("sets the process exit code from statusCommand()", () => {
    assert.match(source, /process\.exitCode\s*=\s*statusCommand\(/);
  });

  it("imports no GitHub write, no sandbox, no build and no agent", () => {
    const imports = [...source.matchAll(/^import\s[^;]*?from\s*"[^"]+";/gms)].map((match) => match[0]).join("\n");

    for (const name of [
      "@ai-hero/sandcastle",
      "follow-up-pass.mts",
      "build.mts",
      "agents.mts",
      "ensureHostLabels",
      "cacheHostLogin",
      "requestCopilotReview",
      "addPullRequestLabel",
      "handBack",
    ]) {
      assert.ok(!imports.includes(name), `status.mts imports ${name}`);
    }
    assert.match(imports, /statusCommand/);
  });

  it("doesn't call ensureHostLabels or cacheHostLogin, which write or have side effects", () => {
    assert.ok(!source.includes("ensureHostLabels("));
    assert.ok(!source.includes("cacheHostLogin("));
  });
});

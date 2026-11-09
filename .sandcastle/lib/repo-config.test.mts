import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECK_PATHS, GATE_COVERED_CHECKS, ROLE_AGENTS, SANDBOX_SKILLS } from "./repo-config.mts";

// This repo's own values in lib/repo-config.mts, pinned to the files they describe. The Owned tests take their values from the
// config, so none of them notices a CI job that was renamed or a test project that was added.

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = join(root, ".github/workflows");
const workflowText = readdirSync(workflows)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => readFileSync(join(workflows, file), "utf8"))
  .join("\n");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The projects ci.yml runs a "Tests: <folder>" job for: .github/scripts/discover_tests.py takes every tests/**/*.csproj whose IsTestProject
// is true, which Directory.Build.props sets for a project name containing ".Tests", and names the job after the project's folder.
const testProjects = (readdirSync(join(root, "tests"), { recursive: true }) as string[])
  .map((entry) => entry.split("\\").join("/"))
  .filter((entry) => entry.endsWith(".csproj") && basename(entry).includes(".Tests"))
  .map((entry) => basename(dirname(entry)));

describe("GATE_COVERED_CHECKS", () => {
  // ci.yml names each matrix job "Tests: <folder>", and the follow-up pass matches a check by its exact name.
  it("names a Tests job for every test project under tests/, and none for a project that isn't there", () => {
    const listed = GATE_COVERED_CHECKS.filter((name) => name.startsWith("Tests: ")).map((name) => name.slice("Tests: ".length));

    assert.deepEqual([...listed].sort(), [...testProjects].sort());
  });

  // scripts/gate.sh reproduces the lints of lint-actions.yml (`run_tool <name>`), whose jobs carry the same names.
  it("names every lint job scripts/gate.sh runs from lint-actions.yml", () => {
    const gate = readFileSync(join(root, "scripts/gate.sh"), "utf8");
    const lintJobs = readFileSync(join(workflows, "lint-actions.yml"), "utf8");
    const tools = [...gate.matchAll(/^\s*run_tool (\w+) /gm)].map((match) => match[1] as string);

    assert.ok(tools.length > 0, "scripts/gate.sh has no run_tool call");
    for (const tool of tools) {
      assert.match(lintJobs, new RegExp(`^\\s*name:\\s*${escaped(tool)}\\s*$`, "m"), `lint-actions.yml has no job named ${tool}`);
      assert.ok(GATE_COVERED_CHECKS.includes(tool), `GATE_COVERED_CHECKS lacks ${tool}`);
    }
  });

  it("matches the name ci.yml gives its test matrix jobs", () => {
    assert.match(workflowText, /name: "Tests: \$\{\{ matrix\.test_name \}\}"/);
  });

  // A job is found by its `name:`, or by its id when it has none.
  for (const name of GATE_COVERED_CHECKS.filter((check) => !check.startsWith("Tests: "))) {
    it(`names a job in a workflow: ${name}`, () => {
      const byName = new RegExp(`^\\s*name:\\s*["']?${escaped(name)}["']?\\s*$`, "m");
      const byId = new RegExp(`^  ${escaped(name)}:\\s*$`, "m");

      assert.ok(byName.test(workflowText) || byId.test(workflowText), `no workflow job is called ${name}`);
    });
  }
});

describe("CHECK_PATHS", () => {
  it("lists only paths that exist", () => {
    for (const path of CHECK_PATHS) assert.ok(existsSync(join(root, path)), `${path} does not exist`);
  });

  // The gate picks its test projects with .github/scripts/discover_tests.py, and builds and lints with these files' rules, so an
  // agent that edits one can make the gate and CI pass with fewer checks. A PR whose branch changes one lists it for the reviewer.
  it("lists the places the gate reads its checks from", () => {
    for (const path of [
      "scripts/",
      ".github/ci/",
      ".github/workflows/",
      ".github/scripts/",
      "Directory.Build.props",
      "Directory.Packages.props",
      ".editorconfig",
      "global.json",
      ".markdownlint-cli2.jsonc",
      ".yamllint.yml",
    ]) {
      assert.ok(CHECK_PATHS.includes(path), `CHECK_PATHS lacks ${path}`);
    }
  });

  // Tests decide what the gate proves, and these .claude files decide what the reviewers may read and do.
  it("lists the tests and the files that govern the reviewers", () => {
    for (const path of ["tests/", ".claude/settings.json", ".claude/skills/", ".claude/agents/"]) {
      assert.ok(CHECK_PATHS.includes(path), `CHECK_PATHS lacks ${path}`);
    }
  });

  it("covers the folder every test project is in", () => {
    assert.ok(testProjects.length > 0);
    assert.ok(CHECK_PATHS.includes("tests/"), "CHECK_PATHS lacks tests/, which holds every test project");
  });

  it("ends a folder with a slash", () => {
    for (const path of CHECK_PATHS) assert.equal(statSync(join(root, path)).isDirectory(), path.endsWith("/"), path);
  });
});

describe("ROLE_AGENTS", () => {
  // intake, planner and critique answer with structured output (Output.object), which one iteration produces: a second iteration of a
  // role that already answered costs a whole round (the comment above ROLE_AGENTS in lib/repo-config.mts). reviewer, gate-fixer and
  // follow-up are single-shot by design (docs/plans/sandcastle-workflow.md). The other roles' values are free to move.
  for (const role of ["intake", "planner", "critique", "reviewer", "gate-fixer", "follow-up"] as const) {
    it(`runs ${role} for one iteration`, () => {
      assert.equal(ROLE_AGENTS[role].maxIterations, 1);
    });
  }
});

describe(".sandcastle/check.sh", () => {
  // The gate runs `pnpm run check:sandcastle` only when one of check.sh's paths changed, and no CI job runs it, so a file that a
  // .sandcastle test reads must be watched or a change to it passes the gate with that test unrun.
  // check.sh watches its built-in paths plus the pathspecs in .sandcastle/check-paths.txt (Seed); this repo's tests read the files listed there.
  // Read the list as check.sh does: a CR, CRLF or LF ends a line, a leading byte-order mark is dropped, and only ASCII whitespace is trimmed,
  // so a line ending in a non-breaking space stays a different pathspec there, and here.
  const pathspecLines = (text: string) =>
    text
      .split(/\r\n|\r|\n/)
      .map((line) => line.replace(/^\uFEFF/, "").replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, ""))
      .filter((line) => line !== "" && !line.startsWith("#"));
  const watched = pathspecLines(readFileSync(join(root, ".sandcastle/check-paths.txt"), "utf8"));
  // Every file the gate and these tests read through CHECK_PATHS must be watched, or deleting or adding one skips the check that would
  // catch it. .sandcastle/ and package.json are check.sh's built-in paths. A watched line covers an entry only when it equals the entry or
  // contains it, so a narrower line (.claude/skills/code-review) can't stand in for the folder. Two folders are watched narrowly on purpose,
  // because the tests read only some of their files: the test projects (tests/**/*.csproj) and the scripts the tests name.
  const narrowOnPurpose: Record<string, string> = { "tests/": ":(glob)tests/**/*.csproj", "scripts/": "scripts/gate.sh" };
  const withoutGlobMagic = (line: string) => line.replace(/^:\(glob\)/, "").replace(/\/$/, "");

  // check.sh diffs all the lines together, so an exclude line (:(exclude), :^, :!, :/!, in any spelling git accepts) would trim what the
  // others watch, and an exclude only a glob can describe can't be told from a path by text. Rather than parse every pathspec form, this
  // repo's list holds plain paths and the :(glob) form only: any other line starting with ":" fails.
  const linesWithOtherMagic = (lines: string[]) => lines.filter((line) => !/^(?::\(glob\))?[^:]/.test(line));

  const unwatchedEntries = (lines: string[], entries: readonly string[]) =>
    entries.filter((entry) => {
      if (entry === ".sandcastle/" || entry === "package.json") return false;
      if (entry in narrowOnPurpose) return !lines.includes(narrowOnPurpose[entry]!);
      const wanted = entry.replace(/\/$/, "");
      return !lines.some((line) => {
        const spec = withoutGlobMagic(line);
        return spec === wanted || wanted.startsWith(`${spec}/`);
      });
    });

  it("watches every CHECK_PATHS entry, besides check.sh's built-in .sandcastle/ and package.json", () => {
    assert.deepEqual(unwatchedEntries(watched, CHECK_PATHS), []);
  });

  it("names an entry whose line is missing, or that only a narrower line covers", () => {
    assert.deepEqual(unwatchedEntries(watched.filter((line) => line !== ".github/scripts"), CHECK_PATHS), [".github/scripts/"]);
    assert.deepEqual(unwatchedEntries(watched.filter((line) => line !== ".claude/skills"), CHECK_PATHS), [".claude/skills/"]);
    assert.deepEqual(unwatchedEntries(watched.filter((line) => line !== ":(glob)tests/**/*.csproj"), CHECK_PATHS), ["tests/"]);
    assert.deepEqual(unwatchedEntries(watched.filter((line) => line !== "scripts/gate.sh"), CHECK_PATHS), ["scripts/"]);
  });

  it("reads the list like check.sh: drops a BOM and CR, trims ASCII whitespace only, skips comments", () => {
    assert.deepEqual(pathspecLines("\uFEFFa\r\n  b \t\r# c\n\n d\u00A0\n#e\n\uFEFF\n"), ["a", "b", "d\u00A0"]);
    assert.deepEqual(unwatchedEntries([...watched.filter((line) => line !== ".github/scripts"), ".github/scripts\u00A0"], CHECK_PATHS), [".github/scripts/"]);
  });

  it("covers an entry by a line that contains it, but not by a line that only shares its name prefix", () => {
    const without = watched.filter((line) => line !== ".github/scripts");

    assert.deepEqual(unwatchedEntries([...without, ".github"], CHECK_PATHS), []);
    assert.deepEqual(unwatchedEntries([...without, ".github/"], CHECK_PATHS), []);
    assert.deepEqual(unwatchedEntries([...without, ".github/scr"], CHECK_PATHS), [".github/scripts/"]);
    assert.deepEqual(unwatchedEntries([...without, ".github/scripts-old"], CHECK_PATHS), [".github/scripts/"]);
    assert.deepEqual(unwatchedEntries([...without, ".gith"], CHECK_PATHS), [".github/scripts/"]);
  });

  it("keeps the built-in .sandcastle/ and package.json out of the list's reach", () => {
    assert.deepEqual(unwatchedEntries([], CHECK_PATHS).includes(".sandcastle/"), false);
    assert.deepEqual(unwatchedEntries([], CHECK_PATHS).includes("package.json"), false);
  });

  it("holds only plain paths and :(glob) lines", () => {
    assert.deepEqual(linesWithOtherMagic(watched), []);
  });

  for (const line of [
    ":(exclude).github/scripts",
    ":(exclude)",
    ":(glob,exclude).github/scripts",
    ":(exclude,glob).github/scripts",
    ":(top,exclude).github/scripts",
    ":(top).github/scripts",
    ":^.github/scripts",
    ":!.github/scripts/",
    ":!",
    ":/!.github/scripts",
    ":/^.github/scripts",
    ":!/.github/scripts",
    ":/.github/scripts",
    ":(glob):!x",
    ":(glob)",
    ":(glob):(glob)x",
    ":",
  ]) {
    it(`refuses the pathspec-magic line ${JSON.stringify(line)}`, () => {
      assert.deepEqual(linesWithOtherMagic(["README.md", line]), [line]);
    });
  }

  it("accepts a plain path, a :(glob) line and a path that has a colon later", () => {
    assert.deepEqual(linesWithOtherMagic(["docs", ":(glob)tests/**/*.csproj", "docs/a:b", "!x", "^x", "/x", "./x"]), []);
  });

  for (const path of [
    "README.md",
    "CLAUDE.md",
    ".gitignore",
    "scripts/gate.sh",
    "scripts/check-branch-name.sh",
    "scripts/watch-pr.sh",
    ".claude/skills/code-review",
    ".claude/rules",
    ".claude/settings.json",
    "docs/plans/sandcastle-workflow.md",
    ".github/workflows",
    ".github/ci",
  ]) {
    it(`reruns the Sandcastle check when ${path} changes`, () => {
      assert.ok(watched.includes(path), `check.sh doesn't watch ${path}`);
    });
  }
});

// .github/ci/sandcastle-skills.txt is what the Sandcastle workflow installs on the runner; SANDBOX_SKILLS is what lib/skills.mts mounts.
// An Actions run mounts only what the file lists, so the two must name the same skills, at one pinned dotfiles commit.
describe("sandcastle-skills.txt", () => {
  const lines = readFileSync(join(root, ".github/ci/sandcastle-skills.txt"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  const skills = lines.filter((line) => line.startsWith("skill ")).map((line) => line.slice("skill ".length));

  it("lists exactly SANDBOX_SKILLS, each once", () => {
    assert.deepEqual([...skills].sort(), [...SANDBOX_SKILLS].sort());
  });

  it("pins one dotfiles commit and holds nothing else", () => {
    assert.equal(lines.filter((line) => /^dotfiles-sha [0-9a-f]{40}$/.test(line)).length, 1);
    assert.equal(lines.length, skills.length + 1);
  });
});

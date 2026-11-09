# Shared role rules

## Build and tests

An issue changes one stack or both. Use the commands for each stack the issue touches:

| Stack | Where | Build (every commit passes it) | Run tests |
| --- | --- | --- | --- |
| .NET | `src/`, `tests/` | `dotnet build Auth0ManagementApp.slnx`, with no warnings (`TreatWarningsAsErrors` is on) | `dotnet test --project tests/<Project>/<Project>.csproj` |
| Sandcastle's TypeScript | `.sandcastle/`, `package.json` | `pnpm exec tsc --noEmit -p .sandcastle`, with no errors | `pnpm exec tsx --test <file>.test.mts` |
| pnpm workspace | `package.json`, `src/UI/package.json`, `pnpm-workspace.yaml` | run `pnpm install` after changing a `package.json`, and commit `pnpm-lock.yaml` in the same commit | the tests of the stack that uses the package |

- Tests must pass by the end of the last developer run, not on every commit.
- The .NET build of `src/UI` runs the Tailwind CLI from `src/UI`'s pnpm packages, so it fails with an error naming `pnpm install` when they're missing.
- The standards for each stack: `docs/CODING_STANDARDS.md` for .NET, and `.claude/rules/sandcastle.md` for `.sandcastle/`.

## The gate

`scripts/gate.sh` is the one definition of "ready to push". It lints the changed YAML and Markdown files, runs the Sandcastle check when `.sandcastle/`, `package.json` or the pnpm lockfile changed,
builds the solution in Release and runs every test project, stopping at the first failure. Run it rather than the individual lint, build and test commands.

- If you committed anything, run `scripts/gate.sh` once as your last step, before `<promise>COMPLETE</promise>`, and fix what it reports.
- The tester is exempt, because its tests are red on purpose. It still builds and lints the files it changed.
- The architect is exempt too. It commits at most one ADR, and lints that file with `pnpm exec markdownlint-cli2 <file>`.
- After you finish, the host runs the gate itself. Its exit code decides whether the branch is published, not what you report.
- Leave the worktree clean: commit or discard every change before you finish. Only commits are pushed, so the host fails the gate when anything is left uncommitted.

## Commits

Commit in small steps. Each message follows `.github/instructions/git-commit-instructions.md`:

- Subject: `<type>(<scope>): <Summary>`, for example `test(Domain): Add Result null-conversion test` or `feat(Domain): Port Result with targeted fixes`
- Body: what changed and why, key decisions, and any blockers for the next run
- Footer: `Refs #<issue number>`

## GitHub

Never push, never run `gh`, and never write to GitHub. The sandbox has no GitHub token. The host publishes the branch and does every GitHub write.

## UI developer

The UI developer owns the Blazor markup and styling, and the tests of them. Its files are:

- the `.razor`, `.razor.cs`, `.razor.css` and `.razor.js` files under `src/UI/Components/` (the layout, pages, shared components and each slice's components), the `.cs` helpers
  that sit beside the layout and shared components (the tone, kind and size enums, the footer's labels), `src/UI/Styles/` and `src/UI/wwwroot/`;
- the tests of those files in `tests/UI.Tests.Unit/`: the bUnit component and page tests (`Components/Layout/`, `Components/Pages/`, `Components/Shared/` and each slice's
  page and component tests), the stylesheet test in `Styles/`, and the tests that check a page's declaration (render mode, route, authorization).
  A test helper that both kinds of test use (`RolesTestData.cs`) is the developer's.

Everything else is the developer's: the `.cs` files of a slice in `src/UI/Components/Features/<Feature>/` (handlers, queries, commands, validators, endpoints, the `Add<Feature>Feature()`
registration) and their tests, `src/UI/ManagementApi/`, `src/Domain/`, and the other test projects. Style with Tailwind CSS v4 and the `accent-*` Palette classes as
`docs/CODING_STANDARDS.md` says.

# CLAUDE.md

This repository is the Auth0 Management App: a server-rendered Blazor Web App on .NET 10 and C# 14, with Tailwind CSS
v4 theming and Auth0 authentication, that lets an Admin manage the Users and Roles of one Auth0 Tenant. An Admin edits a
User's Profile Fields, adds and removes their Roles, and creates new Roles, all through the Management API. The app never
changes a User's password or username, never creates or deletes Users, and never deletes Roles. It isn't a template, so
don't write docs or code for "apps generated from it".

Today it holds the Shared Kernel (`src/Domain/`), the Blazor Web App (`src/UI/`, with a Home page, the Tailwind build,
the Auth0 sign-in and sign-out in the `Authentication` slice, a User's claims in the `Profile` slice, the Admin-only page
in the `Admin` slice, the Theme control in the `Themes` slice and the Palette menu in the `Palettes` slice), the Aspire
AppHost and ServiceDefaults, and their tests. User and Role management isn't built yet.
The slices will call the Management API through one deep interface, `IManagementApi` in `src/UI/ManagementApi/`, that
returns `Result` and our own records, with the SDK, the cached client-credentials token and settings under
`Auth0:Management:*` behind it, and a token bucket that throttles every call to stay under Auth0's rate limits
(see `docs/adr/0009-one-deep-management-api-seam.md`). `mpaulosky/Articles`
(`src/Web/Components/Features/UserManagement/`) is a reference for the SDK calls, not for that seam.

## Auth0 Management API

- The app signs Admins in with one Auth0 application (Regular Web Application, `Auth0:*` settings) and calls the
  Management API with a second (Machine to Machine, `Auth0:Management:Domain`, `:ClientId`, `:ClientSecret`). Never reuse
  the sign-in application's credentials for the Management API.
- Grant the Machine to Machine application only `read:users`, `update:users`, `read:roles`, `create:roles`,
  `read:role_members`, `create:role_members` and `delete:role_members`. A feature that needs another scope adds it to
  `README.md`'s table.
- Management API calls happen on the server, inside a slice's handler, behind an interface so tests substitute it. The
  Management API token never reaches the browser or the logs.
- Every page and endpoint that reads or changes Users or Roles requires the Admin policy (`[Authorize]` with it, not
  `<AuthorizeView>` alone): hiding a button isn't a security boundary.
- The Management API's failures (not found, rate limited, a field Auth0 won't change) come back as a failed `Result`
  with a stable error code, for example `"User.NotFound"` or `"Role.AlreadyExists"`.

## Domain language

@CONTEXT.md

## Coding standards

`docs/CODING_STANDARDS.md` wins when any rule file disagrees with it. Path-scoped rules in `.claude/rules/` add
guidance for Blazor, .NET, Markdown, blog posts, Sandcastle and the Baseline's CI files, and load when you work on
matching files.

@docs/CODING_STANDARDS.md

## Project layout

- `src/Domain/`: the Shared Kernel (`Result`/`Result<T>` and `ApplicationConstants`). It references no other project
  or package (see `docs/adr/0001-shared-kernel-in-domain-project.md`).
- `src/UI/`: the Blazor Web App. Each feature slice (components, request and response records, handler, validator,
  `Add<Feature>Feature()` registration) lives in its own folder under `Components/Features/<Feature>/`; the layout is in
  `Components/Layout/`, and the app-wide Error and NotFound pages are in `Components/Pages/`. `Security/` holds
  cross-cutting code that isn't a component, such as `LocalReturnUrl`, and depends on no slice (see
  `docs/adr/0007-cross-cutting-code-outside-the-slices.md`). `src/UI` references only
  `src/Domain` and `src/ServiceDefaults` (see `docs/adr/0005-feature-slices-live-in-the-ui-project.md` and its amendment,
  `docs/adr/0006-ui-references-servicedefaults.md`).
- `src/AppHost/`: the Aspire AppHost (entry file `AppHost.cs`). It runs the UI as the resource
  `ApplicationConstants.Website` (`WebApp`) with the UI launch profile of the same name as its own: `https` locally,
  `http` where there's no developer certificate. Tests that start the AppHost pass `--DOTNET_LAUNCH_PROFILE=http`,
  because the testing builder otherwise applies the AppHost's first profile, `https`.
- `src/ServiceDefaults/`: OpenTelemetry (logging, metrics, tracing) and health checks, added by `AddServiceDefaults()`.
  `MapDefaultEndpoints()` maps `/health` and `/alive` in Development only. It references no project, and has no HTTP
  resilience or service discovery package until something calls another service.
- `src/UI/Styles/app.tailwind.css`: the Tailwind CSS v4 source. The build runs the Tailwind CLI (a devDependency in
  `src/UI/package.json`, part of the pnpm workspace) to write `src/UI/wwwroot/css/app.css`, which git ignores.
- `tests/Architecture.Tests/`, `tests/Domain.Tests.Unit/`, `tests/UI.Tests.Unit/` (bUnit),
  `tests/UI.Tests.Integration/` (`WebApplicationFactory<Program>`), `tests/AppHost.Tests.Integration/`
  (`Aspire.Hosting.Testing`, starts the AppHost), `tests/UI.Tests.E2E/` (Playwright in headless Chromium, through the
  AppHost; its fixture installs Chromium itself): test projects, named `<Project>.Tests.<Kind>`.
- `aspire.config.json` (the Aspire CLI's shared settings) lives at the repo root and points at
  `src/AppHost/AppHost.csproj`. It's the only copy: delete any the CLI writes elsewhere, such as next to the AppHost.
- `.sandcastle/`: the unattended agent pipeline (TypeScript, run with Claude Code).
- `.github/workflows/`, `.github/scripts/`, `.github/hooks/`: CI, release blog tooling and git hooks.
- `.claude/skills/code-review/`: the PR review checklist. GitHub's Copilot code review gets the same checklist through
  `.github/copilot-instructions.md`, which is generated: edit the skill, then run `scripts/sync-copilot-review.sh`.
- `docs/adr/`: architecture decision records. `docs/blogs/` is generated by the release workflow; don't edit it by hand.

## Commands

The repo uses pnpm (pinned by `packageManager` in `package.json`); npm is refused. The UI build runs the Tailwind CLI
from the pnpm packages: a local build runs `pnpm install --frozen-lockfile` itself when they're missing, and fails with
an error naming `corepack enable pnpm` when pnpm is missing or won't run. CI installs them in `.github/ci/prepare.sh`.
Run `pnpm install` after changing any `package.json`, and commit `pnpm-lock.yaml` with the change.

```bash
pnpm install                                          # the pnpm workspace: root tooling and src/UI's Tailwind CLI
scripts/gate.sh                                       # the full check; needs a fresh `git fetch origin main`
dotnet build Auth0ManagementApp.slnx                  # quick build while iterating
dotnet test --project tests/<Project>/<Project>.csproj  # one test project while iterating
dotnet run --project src/UI                           # run the Blazor Web App
aspire run                                            # run the AppHost over HTTPS: WebApp plus the Aspire dashboard
dotnet run --project src/AppHost --launch-profile http  # the same without the Aspire CLI or a dev certificate
pnpm --dir src/UI run watch:css                       # rebuild the CSS live while editing markup
pnpm run check:sandcastle                             # type-check and test .sandcastle/
SANDCASTLE_ISSUE=<n> pnpm run sandcastle              # build one issue (and its PR) locally
SANDCASTLE_LABEL=<label> pnpm run sandcastle          # work the issues labelled <label>, e.g. Sandcastle:dev
```

`scripts/gate.sh` is the definition of "ready to push": lint of the changed YAML, Markdown, workflows and shell
scripts, then this repo's own checks in `.github/ci/gate-checks.sh` (the Copilot review sync check and the Sandcastle
check, each when its files changed), then a Release build and each test project under `tests/`, run one by one.
`scripts/gate.sh` is an Owned file of the CI Baseline (see `.claude/rules/baseline.md`), overwritten on every Apply,
so a new repo-only check goes in `gate-checks.sh`. Don't use `dotnet test --solution` as the check: under Microsoft
Testing Platform it can report zero tests while the project runs pass. The pre-push hook runs the gate after its own branch
checks (no pushes to `main`, `preview` or `dev`, the branch names in `docs/PROCESS.md`, and a clean tree at the pushed
commit). Sandcastle doesn't go through the hook: it pushes the commit its sandbox gated from the main checkout, with git
hooks off.

Push from a checkout of the branch being pushed, with nothing uncommitted or untracked in it: the hook gates the
checked-out commit, so it refuses `git push origin <other-branch>` from the `main` checkout. Push from the branch's
worktree (see `docs/PROCESS.md`). To push a branch that has none, check it out in a temporary
`git worktree add ../auth0-management-app-worktrees/<folder> <branch>` rather than stashing and switching in the main checkout.

## Git workflow

Branches, worktrees, commits, PR titles and descriptions, merging and releases follow
[docs/PROCESS.md](docs/PROCESS.md). Commit messages follow `.github/instructions/git-commit-instructions.md`.

Don't start work on an issue labelled `sandcastle:building`: a Sandcastle run is building it, and the label clears when
that build ends. Check before running `/implement-spec` or opening a branch for an issue.

Claude reviews a PR only when it has the `review:claude` label. Add the label to every PR you open. Sandcastle adds it to
the PRs it opens itself. Add it by hand to a PR the run report lists under **Pull requests without `review:claude`**, and
to any open Sandcastle PR that has never had it: one opened before Sandcastle labelled its PRs, or one whose run stopped
between creating it and labelling it.

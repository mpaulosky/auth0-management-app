# Auth0 Management App

[![Build and Test Suite](https://github.com/mpaulosky/auth0-management-app/actions/workflows/ci.yml/badge.svg)](https://github.com/mpaulosky/auth0-management-app/actions/workflows/ci.yml)
[![CodeQL](https://github.com/mpaulosky/auth0-management-app/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/mpaulosky/auth0-management-app/actions/workflows/codeql-analysis.yml)
[![.NET code metrics](https://github.com/mpaulosky/auth0-management-app/actions/workflows/code-metrics.yml/badge.svg)](https://github.com/mpaulosky/auth0-management-app/actions/workflows/code-metrics.yml)
[![Lint Markdown](https://github.com/mpaulosky/auth0-management-app/actions/workflows/lint-markdown.yml/badge.svg)](https://github.com/mpaulosky/auth0-management-app/actions/workflows/lint-markdown.yml)
[![Lint YAML](https://github.com/mpaulosky/auth0-management-app/actions/workflows/lint-yaml.yml/badge.svg)](https://github.com/mpaulosky/auth0-management-app/actions/workflows/lint-yaml.yml)

[![Codecov](https://img.shields.io/codecov/c/github/mpaulosky/auth0-management-app?logo=codecov)](https://codecov.io/gh/mpaulosky/auth0-management-app)
[![Latest release](https://img.shields.io/github/v/release/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/releases/latest)
[![License](https://img.shields.io/github/license/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/blob/main/LICENSE)
[![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet)](https://dotnet.microsoft.com/download/dotnet/10.0)

[![Open issues](https://img.shields.io/github/issues/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/issues)
[![Closed issues](https://img.shields.io/github/issues-closed/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/issues?q=is%3Aissue+is%3Aclosed)
[![Open PRs](https://img.shields.io/github/issues-pr/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/pulls)
[![Closed PRs](https://img.shields.io/github/issues-pr-closed/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/pulls?q=is%3Apr+is%3Aclosed)
[![Stars](https://img.shields.io/github/stars/mpaulosky/auth0-management-app)](https://github.com/mpaulosky/auth0-management-app/stargazers)

## About

Auth0 Management App is a server-rendered Blazor Web App on .NET 10 for managing the **User**s and **Role**s of one Auth0
**Tenant**, without opening the Auth0 dashboard. Only an **Admin** (a User with the `Admin` Role) can manage anything.

When finished, it will let an Admin:

- **Browse Users**: list the Tenant's Users with their email and current Roles.
- **Edit a User's Profile Fields**: change their name, given name, family name, nickname, picture URL and email.
  The app never changes a User's password or username, and doesn't create or delete Users.
- **Add and remove Roles**: assign any of the Tenant's Roles to a User, or take one away.
- **Create Roles**: add a new Role, with a name and description, when the existing ones don't fit.

The app talks to Auth0 in two ways:

- **Sign-in** uses a Regular Web Application and `Auth0.AspNetCore.Authentication`, with cookie sessions. Tokens stay on the server.
- **Management** uses a separate Machine to Machine application that holds a client-credentials grant for the
  [Auth0 Management API](https://auth0.com/docs/api/management/v2). The app requests its token on the server and caches it,
  and never sends it to the browser.

See [CONTEXT.md](https://github.com/mpaulosky/auth0-management-app/blob/main/CONTEXT.md) for the exact meaning of
**User**, **Admin** and the other terms.

### Status

Early stage. Built so far:

- The Blazor Web App (`src/UI`) with a Home page, a nav menu, NotFound and Error pages, and the Tailwind CSS v4 build.
- Sign-in and sign-out through Auth0, with the `Admin` Role mapped from the ID token.
- A Profile page that lists the signed-in User's own claims, and an Admin page only an Admin can open.
- A Users page at `/admin/users` where an Admin searches and pages through the Tenant's Users, with an **Admin** badge on
  those who hold the Role. The Management API calls sit behind one interface.
- A Roles page at `/admin/roles` with a tile for each Role and a table of Users with a column per Role. Picking a tile
  filters the table to that Role's Users.
- A light/dark **Theme** and a **Palette** that tints the accent and the surfaces, both kept in cookies.
- The Aspire AppHost, the ServiceDefaults and the tests for all of the above.

Planned next: the User detail pane, the Profile Fields editor, Role assignment and Role creation, all through the Management API.

### Look and feel

The **Theme** is chosen from a Light, Dark and System group in the nav, on desktop and in the mobile menu. Each button
posts to `/theme`, which stores the choice in a `theme` cookie and returns to the same page, so it works without
JavaScript. The server reads the cookie as it renders and writes `data-theme` on `<html>`, so the first paint already
uses the chosen Theme. System, the default, deletes the cookie and follows the OS preference.

The **Palette** is chosen from a menu of 17 Tailwind hues, from Red to Rose, opened from a swatch button in the nav on desktop and shown
as a Palette section in the mobile menu. Each tile posts to `/palette`, which stores the hue in a `palette` cookie and returns to the
same page, again without JavaScript. The server writes `data-palette` on `<html>`, and a CSS rule for each hue swaps the accent scale.
Blue, the default, renders no attribute.

## Releases

<!-- RELEASES_START -->

| Version | Date | Title | Blog post |
| ------- | ---- | ----- | --------- |
| [v0.0.22](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.22) | 2026-10-20 | feat(Roles): List the Roles and the Users who hold them | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-69-feat-roles-list-the-roles-and-the-users-who-hold-them.md) |
| [v0.0.21](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.21) | 2026-10-20 | feat(sandcastle): Follow up on hand-opened PRs labelled for it | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-70-feat-sandcastle-follow-up-on-hand-opened-prs-labelled-for-it.md) |
| [v0.0.20](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.20) | 2026-10-20 | feat(Users): List and search the Tenant's Users | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-59-feat-users-list-and-search-the-tenant-s-users.md) |
| [v0.0.19](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.19) | 2026-10-20 | ci(sandcastle): Answer PR follow-ups without waiting behind a build | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-64-ci-sandcastle-answer-pr-follow-ups-without-waiting-behind-a-build.md) |
| [v0.0.18](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.18) | 2026-10-20 | feat(ManagementApi): Cache Management API reads | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-56-feat-managementapi-cache-management-api-reads.md) |
| [v0.0.17](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.17) | 2026-10-20 | ci(sandcastle): Add switched-off triggers for follow-up runs | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-60-ci-sandcastle-add-switched-off-triggers-for-follow-up-runs.md) |
| [v0.0.16](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.16) | 2026-10-20 | feat(sandcastle): Label every Sandcastle PR that never had review:claude | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-20-pr-55-feat-sandcastle-label-every-sandcastle-pr-that-never-had-review-claude.md) |
| [v0.0.15](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.15) | 2026-10-19 | chore(scripts): Watch every hand-opened PR until it merges | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-19-pr-54-chore-scripts-watch-every-hand-opened-pr-until-it-merges.md) |
| [v0.0.14](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.14) | 2026-10-19 | ci(sandcastle): Start a follow-up pass when Claude Review completes | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-19-pr-46-ci-sandcastle-start-a-follow-up-pass-when-claude-review-completes.md) |
| [v0.0.13](https://github.com/mpaulosky/auth0-management-app/releases/tag/v0.0.13) | 2026-10-19 | feat(sandcastle): Label each PR Sandcastle opens review:claude | [Post](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/blogs/2026-10-19-pr-45-feat-sandcastle-label-each-pr-sandcastle-opens-review-claude.md) |

<!-- RELEASES_END -->

[All releases →](https://github.com/mpaulosky/auth0-management-app/releases)

## Getting started

1. Clone the repository:

   ```bash
   git clone https://github.com/mpaulosky/auth0-management-app.git
   cd auth0-management-app
   ```

2. Install the prerequisites:

   - The .NET SDK `10.0.401`, as pinned in [global.json](https://github.com/mpaulosky/auth0-management-app/blob/main/global.json) (later 10.0 feature bands are accepted).
   - Node.js and pnpm (`corepack enable`), used by the Tailwind CSS build, the git hooks and the lint tools. The repo refuses `npm install`.
   - [yamllint](https://yamllint.readthedocs.io/), which the pre-push hook runs on changed YAML files.

3. Set up Auth0 as described in [Auth0 setup](#auth0-setup). The app won't start without it.

4. Install the pnpm packages, then build and test each test project:

   ```bash
   pnpm install
   dotnet build Auth0ManagementApp.slnx
   (for project in tests/*/*.csproj; do dotnet test --project "$project" || exit 1; done)
   ```

   Run the test projects one at a time, as `scripts/gate.sh` and CI do. Under Microsoft Testing Platform,
   `dotnet test --solution` can report zero tests even when the projects pass.

   `pnpm install` must come first: `dotnet build` runs the Tailwind CLI to write `src/UI/wwwroot/css/app.css`, and fails
   with an error naming `pnpm install` when the packages are missing.

5. Run the app through the Aspire AppHost, which starts the UI as `WebApp` and opens the Aspire dashboard with its logs,
   traces and metrics, or run the UI on its own:

   ```bash
   aspire run
   dotnet run --project src/AppHost --launch-profile http
   dotnet run --project src/UI
   ```

   `aspire run` needs the [Aspire CLI](https://aspire.dev/get-started/install-cli/) and uses the AppHost's `https`
   profile, which serves both the dashboard and `WebApp` over HTTPS (`https://localhost:7161`). The `http` profile needs
   no developer certificate.

   The `https` profile needs a trusted developer certificate. Trust it once with `dotnet dev-certs https --trust`. On
   Linux, .NET also reads the trusted copy only when `$HOME/.aspnet/dev-certs/trust` is in `SSL_CERT_DIR`, for example
   `export SSL_CERT_DIR="$HOME/.aspnet/dev-certs/trust:/etc/ssl/certs"` (see <https://aka.ms/dev-certs-trust>).

   In Development, the UI reports its health at `/health` and `/alive`.
   While editing markup, `pnpm --dir src/UI run watch:css` rebuilds the CSS as you save.

6. Optionally enable the git hooks in `.github/hooks` (markdownlint on commit, and `scripts/gate.sh` on push):

   ```bash
   git config core.hooksPath .github/hooks
   ```

   `scripts/gate.sh` lints the files changed since the branch left `origin/main`, then builds and tests the solution in Release. Run it by hand to
   check a branch before pushing.

## Auth0 setup

The app uses two Auth0 applications in the same Tenant: one to sign Admins in, and one to call the Management API.

### Sign-in application

The app won't start without these settings: it validates `Auth0:Domain`, `Auth0:ClientId` and `Auth0:ClientSecret` on
startup and names any that's missing.

1. In the [Auth0 dashboard](https://manage.auth0.com/), create an application of type **Regular Web Application**.
   Sign-in uses the authorization-code flow, so leave the **Authorization Code** grant on (it is by default). The app
   sends the client secret only to Auth0's token endpoint, from the server.
2. In the application's settings, add:
   - **Allowed Callback URLs:** `http://localhost:5112/callback, https://localhost:7161/callback`
   - **Allowed Logout URLs:** `http://localhost:5112/, https://localhost:7161/`

   Sign-in works on the `http` profile only on `localhost`, because the browser keeps Auth0's `Secure` sign-in cookies
   for `http://localhost` alone. The `https` profile is the safer choice anywhere else.
3. Under **User Management → Roles**, create a Role named `Admin` and assign it to yourself and anyone else who should
   manage Users and Roles.
4. Under **Actions → Library**, create a **Post Login** Action that adds the User's Roles to the ID token, and add it to
   the Login flow:

   ```javascript
   exports.onExecutePostLogin = async (event, api) => {
     api.idToken.setCustomClaim('https://auth0-management-app/roles', event.authorization?.roles ?? []);
   };
   ```

5. Store the application's settings as user secrets. `Auth0:Domain` is the Tenant's host only, with no `https://`
   (for example `my-tenant.us.auth0.com`):

   ```bash
   dotnet user-secrets set "Auth0:Domain" "<your-tenant>.auth0.com" --project src/UI
   dotnet user-secrets set "Auth0:ClientId" "<client-id>" --project src/UI
   dotnet user-secrets set "Auth0:ClientSecret" "<client-secret>" --project src/UI
   ```

   The AppHost shares the UI's user secrets, so `aspire run` reads the same values and passes them to `WebApp` as
   `Auth0__Domain`, `Auth0__ClientId` and `Auth0__ClientSecret`. When one is missing, the Aspire dashboard asks for it.
   Outside Development, set those environment variables instead.

`Auth0:RoleClaimType` names the claim the Roles arrive in. It defaults to `https://auth0-management-app/roles`, the
claim the Action above sets; change both together. The app maps each Role in that claim to a .NET role, so an `Admin`
there satisfies the Admin policy.

A Role you add to or remove from yourself takes effect at your next sign-in, when Auth0 issues a new ID token.

### Management API application

The app needs these settings to start, since the Users and Roles pages call the Management API. Under the AppHost, they're
read from the same user secrets and passed on to WebApp.

1. Create an application of type **Machine to Machine** and authorize it for the **Auth0 Management API**.
2. Grant it only these permissions:

   | Permission | Used to |
   | ---------- | ------- |
   | `read:users` | List Users and read one User's profile |
   | `update:users` | Change a User's name, email and the other Profile Fields |
   | `read:roles` | List the Tenant's Roles |
   | `create:roles` | Create a Role |
   | `read:role_members` | List a User's Roles and a Role's Users |
   | `create:role_members` | Assign a Role to a User |
   | `delete:role_members` | Remove a Role from a User |

   Don't grant `delete:users`, `create:users` or any permission the app doesn't use: the client secret can do whatever
   the grant allows.
3. Store its settings as user secrets, the same way:

   ```bash
   dotnet user-secrets set "Auth0:Management:Domain" "<your-tenant>.auth0.com" --project src/UI
   dotnet user-secrets set "Auth0:Management:ClientId" "<m2m-client-id>" --project src/UI
   dotnet user-secrets set "Auth0:Management:ClientSecret" "<m2m-client-secret>" --project src/UI
   ```

   Outside Development, set `Auth0__Management__Domain`, `Auth0__Management__ClientId` and
   `Auth0__Management__ClientSecret` instead. `aspire run` passes these to `WebApp` the same way it passes the sign-in
   settings, and the app won't start without them.

Auth0 lets the app change a User's Profile Fields only where Auth0 owns them: Users in a database connection, or Users
from a social or enterprise connection whose profile isn't synced at each login. Otherwise the identity provider
overwrites the change at that User's next sign-in.

## Project layout

```text
src/AppHost/                     -- Aspire AppHost: runs the UI as the WebApp resource
src/Domain/                      -- Shared Kernel: Result, Result<T>, ApplicationConstants
src/ServiceDefaults/             -- Aspire service defaults: OpenTelemetry and health checks
src/UI/                          -- Blazor Web App (server-rendered)
src/UI/Components/Features/      -- One folder per feature slice (Authentication, Profile, Admin, Themes, Palettes, Users, Roles)
src/UI/Security/                 -- Cross-cutting code that isn't a component, such as LocalReturnUrl
src/UI/Styles/                   -- Tailwind CSS v4 source
tests/AppHost.Tests.Integration/ -- AppHost integration tests (Aspire.Hosting.Testing)
tests/Architecture.Tests/        -- Architecture rules (Domain's dependencies, UI's references, slice boundaries)
tests/Domain.Tests.Unit/         -- Shared Kernel unit tests
tests/UI.Tests.Unit/             -- UI component tests (bUnit)
tests/UI.Tests.Integration/      -- UI integration tests (WebApplicationFactory)
tests/UI.Tests.E2E/              -- End-to-end tests (Playwright, through the AppHost)
docs/adr/                        -- Architecture decision records
aspire.config.json               -- Aspire CLI settings, pointing at src/AppHost
CONTEXT.md                       -- Domain language
.sandcastle/                     -- Sandcastle agent setup
docs/CODING_STANDARDS.md         -- Coding standards
CLAUDE.md, .claude/              -- Claude Code instructions, rules and skills
.github/workflows/               -- CI, code analysis, linting and release workflows
.github/scripts/                 -- Release blog post generator, backfill and pytest tests
.github/copilot-instructions.md  -- Copilot PR review checklist, generated from the code-review skill
```

## Releases and blog posts

Every PR merged to `main` cuts a Release: [release.yml](https://github.com/mpaulosky/auth0-management-app/blob/main/.github/workflows/release.yml)
tags it and opens a release-notes PR, which also copies `README.md` to `docs/README.md` and adds a blog post written by
[release_post.py](https://github.com/mpaulosky/auth0-management-app/blob/main/.github/scripts/release_post.py).
With an `ANTHROPIC_API_KEY` repository secret, each post opens with a short AI summary.
[docs/index.html](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/index.html) is the GitHub Pages home page.

## Contributing

- Name branches `feature/{issue}-{slug}` for issue work, `fix/{issue}-{slug}` for bug fixes, `hotfix/{issue}-{slug}` for
  urgent fixes, or `chore/{slug}` for maintenance with no issue, for example `feature/14-add-root-readme`.
- Issues labelled `Sandcastle` are worked by Sandcastle agents, which open a pull request for review.
- Read [CONTRIBUTING.md](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/CONTRIBUTING.md), the [Code of Conduct](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/CODE_OF_CONDUCT.md)
  and the [Security Policy](https://github.com/mpaulosky/auth0-management-app/blob/main/docs/SECURITY.md) before contributing.

## License

Licensed under the [MIT License](https://github.com/mpaulosky/auth0-management-app/blob/main/LICENSE).

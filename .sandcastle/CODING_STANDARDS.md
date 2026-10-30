# auth0-management-app coding standards

Every Sandcastle role follows these standards, and the reviewer checks the branch against them. This file points at where the standards live rather than copying them.

## Where the rules are

- `.github/instructions/` holds the rules the Baseline Template owns: commit messages, Markdown and blog posts.
- `docs/CODING_STANDARDS.md` holds the .NET, Blazor, Auth0, error handling, validation, architecture and testing standards, and wins when another rule file disagrees.
- `.claude/rules/` holds the path-scoped rules (`blazor.md`, `dotnet.md`, `markdown.md`, `sandcastle.md`).
- `docs/PROCESS.md` says how a change reaches `main`: branches, commits, PR titles and descriptions, checks and review.
- `CLAUDE.md` says how the repo is built and laid out.

## Code

See `docs/CODING_STANDARDS.md` and `.claude/rules/dotnet.md` and `blazor.md`.

## Tests

See "Testing" in `docs/CODING_STANDARDS.md`; the test projects sit under `tests/`.

## Sandcastle's TypeScript

`.sandcastle/` is TypeScript run with `tsx` on Node, with no build step. `pnpm run check:sandcastle` type-checks it and runs every `*.test.mts`.

- Match the module you're in: two-space indents, double quotes, semicolons, and `.mts` imports with the extension.
- Tests sit beside the module as `<module>.test.mts`, written with `node:test` and `node:assert/strict`.
- `main.mts`, `status.mts` and every `lib/` module but `lib/repo-config.mts`, with their tests, are owned by the Baseline Template: don't change them here.
  The repo's own values (role models, hooks, the CI jobs the gate reproduces) go in `lib/repo-config.mts`.

---
name: code-review
description: >-
  Code review for pull requests in the Auth0 Management App. Use when reviewing a pull request or diff for
  correctness, repository standards, domain language, architecture boundaries, tests, docs, and workflows.
---

# Code review

Review the pull request against this repository's own sources of truth. The rules below point at them and add what
they don't say. Every finding cites the file and rule it rests on.

## Sources of truth

Read the sections that govern the changed code before commenting on it:

- `docs/CODING_STANDARDS.md`: style, .NET and Blazor, Auth0, error handling with `Result`, FluentValidation,
  Vertical Slice Architecture, Central Package Management, and testing. It wins when another rule file
  disagrees.
- `CONTEXT.md`: the domain language (Tenant, Management API, Visitor, User, Admin, Role, Profile Fields, Theme, Palette, Shared Kernel, Release).
- `docs/adr/`: recorded decisions. A change that contradicts an ADR needs a new ADR that supersedes it.
- `.claude/rules/`: the path-scoped rules (Blazor, .NET, Markdown and blog posts).
- `docs/PROCESS.md`: branches, commits, PR titles and descriptions, and merging. The commit format is in
  `.github/instructions/git-commit-instructions.md`.

## What to check

**Domain language.** Code, UI text and docs use the `CONTEXT.md` terms with their defined meanings. Flag a synonym
(for example "color scheme" for Palette) or a term used for its neighbour (Theme for Palette).

**Shared Kernel boundary.** `src/Domain` holds only operation outcomes (`Result`, `Result<T>`, `ResultErrorCode`) and
the names the app relies on (`ApplicationConstants`), and it references no other project and no package. Flag
entities, feature logic, validators, persistence types, or a new reference there; feature code belongs in
`src/UI/Components/Features/<Feature>/`.

**Feature slices.** Each slice keeps everything its use case needs in its own `src/UI/Components/Features/<Feature>/`
folder (ADR 0005), and no slice uses another slice's types. `src/UI` references no project other than `src/Domain`.
`tests/Architecture.Tests` enforces both, so flag a change that loosens those tests or works around them, for example
by reaching another slice's types through reflection. App-wide layout and pages stay in `Components/Layout/` and
`Components/Pages/`.

**Tests.** Every new or changed behaviour has a test, following the Testing section of `CODING_STANDARDS.md`. For a
`Result`-returning handler, that means its success value and each error code it can return.

**Markdown.** Lines outside tables stay within 200 characters; table rows can't wrap, so they're exempt. CI's
markdownlint enforces this and the other rules in `.markdownlint-cli2.jsonc`, except in the paths it ignores, such as
the generated posts in `docs/blogs/`.

**Workflows and hooks.** Steps that publish anything (open a PR, push, tag, release) run only for `main`: a
`github.ref == 'refs/heads/main'` check, or a merged-into-`main` condition as in `release.yml`. `workflow_dispatch`
runs on any branch, and pull request runs check out a detached merge commit. Branch names in hooks, prompts and
docs follow `feature/{issue}-{slug}`, `fix/{issue}-{slug}`, `hotfix/{issue}-{slug}` or `chore/{slug}`.

**Sandcastle prompts.** In `.sandcastle/*-prompt.md`, an exclamation mark followed by a backtick runs the text up to
the next backtick as a shell command before the agent sees the prompt. Flag that sequence anywhere it isn't an
intended command expansion, for example in inline code about the null-forgiving operator.

**Sandcastle role prompts can always finish.** When a change touches `.sandcastle/*-prompt.md` or
`.sandcastle/roles/`, follow every case the prompt allows and check that each one ends in a reachable
`<promise>COMPLETE</promise>`, including an exemption, a re-run whose work is already committed, and "nothing to do".
Flag any instruction that contradicts an exemption stated elsewhere in the same prompt or in another role's prompt,
for example a tester exempt from manual criteria who can only finish after committing a failing test, or a reviewer
told to add a test for every missing criterion, including the exempt ones. No lint catches these: read the prompts
together.

## Lenses

Most review findings on this repo's PRs were about behaviour on a path the author didn't test, not style. Each lens below is
one kind of finding that kept recurring. Look through every lens whose files the change touches. The `pre-push-review` skill
gives each one to its own reviewer, and grades every finding with a suggested fix: Critical for a bug in code that runs
(application code, tests and tooling), Warning for a security weakness in any file, and Advisory for docs, comments,
prompts and conventions.

| Lens | Applies to | Ask |
| --- | --- | --- |
| Edge cases | Any code | What do empty, whitespace-only, Unicode, malformed, oversized and boundary inputs do? What if a value is missing, null or duplicated? |
| Races and caches | Shared state, caches, async code, Sandcastle runs | What if two requests, circuits or runs interleave? Can a read already in flight put a stale entry back after a write evicts it? Does every write evict what it makes stale (ADR 0009)? |
| Management API budget | Code that calls `IManagementApi` | How many calls does one page load or action make, on prerender and again once interactive? Per User or per Role in a list? Does it stay inside the token bucket, and what does the Admin see when it doesn't? |
| Error contract | Handlers, `IManagementApi`, components showing errors | Does each expected failure come back as a failed `Result` with the right stable code (a missing Role isn't `User.NotFound`)? Is anything caught too broadly, swallowed, or logged with a token or secret? |
| Blazor lifecycle | `.razor`, `.razor.cs` | Does it work prerendered and then interactive? Is UI changed from a timer, callback or background task wrapped in `InvokeAsync(StateHasChanged)`? Is everything it subscribes to disposed? Does every link and navigation reach a page? |
| Security | Pages, endpoints, auth, workflows | Does every page and endpoint that reads or changes Users or Roles require the Admin policy? Can input reach output, a redirect or a shell unchecked? Can a fork, a bot or a person without write access reach a secret or a write token? |
| Tests | Any behaviour change | Does every new or changed behaviour have a test that fails without the change? Can each assertion actually fail? Are both paths of a `Result` covered, and every testable acceptance criterion? |
| Docs match the code | Comments, `README.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/`, prompts | Does every comment and doc the change touches, or that describes what it changed, still say what the code does? Is a list (slices, labels, scopes) still complete? Does an edit leave a doc contradicting itself? Is a claim about Auth0 or GitHub sourced? |
| Sandcastle host | `.sandcastle/` | Does it fail closed? Does a failure end the run red rather than green or crashing? Is every label it claims released on every path? Does no agent gain a way to reach GitHub? |
| Shell | `*.sh`, hooks | Does it hold under `set -euo pipefail`, an empty variable, a path with spaces, GNU and BSD tools, a missing tool, and the `GIT_*` variables a hook sets? Does every failure exit non-zero? |
| GitHub Actions | `.github/workflows/`, `.github/scripts/` | Which events start it, from which actor, with which token and permissions? What does a skipped, cancelled or failed run do to the PR's merge state? Can a fork's PR reach the secrets? Is every action pinned to a commit no older than `main`'s? |
| Repo conventions | Any file | Does it keep the slice boundaries, the Shared Kernel, Central Package Management, the domain language and the Owned Baseline files (`.claude/rules/baseline.md`) as they are? |

## Out of scope

Leave compiler and analyzer findings to the build: `TreatWarningsAsErrors` and `AnalysisMode=All` already fail CI on
them, and Central Package Management rejects a `Version` on a `PackageReference`. Spend comments on behaviour,
boundaries, tests and intent.

#!/usr/bin/env bash
# Sandcastle's check for the local gate, called by .github/ci/gate-checks.sh:
# type-check .sandcastle/ and run its tests when it, package.json, the pnpm
# files, or a file its tests read (the local review's script, skills and agent, the
# workflows, .github/ci (the skills list the workflow installs), README.md, CLAUDE.md, the gate and branch-name scripts, the code-review
# skill, the rules and the Sandcastle plan) changed since <merge-base> (always, when
# <merge-base> is empty). No CI job runs it, so a file left off this list is never tested.
#
#   .sandcastle/check.sh <merge-base>
set -euo pipefail
base="${1-}"
if [[ -n "$base" ]] && git diff --quiet --no-renames "$base" HEAD -- .sandcastle package.json ':(glob)pnpm-*.yaml' \
  scripts/review.sh scripts/gate.sh scripts/check-branch-name.sh scripts/watch-pr.sh .github/ci \
  .claude/skills/pre-push-review .claude/skills/hardening-review .claude/skills/code-review .claude/agents/pre-push-reviewer.md \
  .claude/rules .claude/settings.json README.md CLAUDE.md .gitignore docs/plans/sandcastle-workflow.md \
  .github/workflows; then
  exit 0
fi
echo "── Sandcastle check"
pnpm run check:sandcastle

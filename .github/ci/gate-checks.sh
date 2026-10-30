#!/usr/bin/env bash
# Repo-specific checks for the local gate, called by scripts/gate.sh after its
# lints and before it builds, so they run in pre-push, in any sandbox that
# runs the gate, and by hand.
#
#   gate-checks.sh <merge-base>
#
# <merge-base> is where this branch left origin/main, or empty when there is
# no origin/main; in that case treat every tracked file as changed. Exit
# non-zero to fail the gate.
#
# scripts/gate.sh is Owned by the repo-ci-baseline Template and is overwritten
# on every Apply; this file is Seed, so it belongs to the repo. Put checks only
# this repo needs here, each guarded by the paths it covers, for example:
#
#   if git diff --quiet "$base" HEAD -- src/Tool; then :; else pnpm run check:tool; fi
set -euo pipefail

base="${1-}"

# Sandcastle's type-check and tests, when the repo runs Sandcastle.
if [[ -x .sandcastle/check.sh ]]; then .sandcastle/check.sh "$base"; fi

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

# changed <pathspec>...: true when any matching path changed since <base>.
# Deletions count.
changed() {
  [[ -z "$base" ]] && return 0
  ! git diff --quiet --no-renames "$base" HEAD -- "$@"
}

# check-git-hooks.sh is Claude Code's SessionStart hook; ci.yml's "Hook tests"
# job is Owned by the Baseline, so the gate is what runs its test. The test also
# checks the files that wire the hook in, so a change to one reruns it.
if changed scripts/check-git-hooks.sh scripts/tests/check-git-hooks.test.sh .claude/settings.json CLAUDE.md .github/ci/gate-checks.sh; then
  echo -e "${CYAN}🪝 Git hooks SessionStart check tests...${RESET}"
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX bash scripts/tests/check-git-hooks.test.sh
else
  echo -e "${GREEN}✅ No git hooks SessionStart check changes to test.${RESET}"
fi

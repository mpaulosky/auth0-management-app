#!/usr/bin/env bash
# Repo-specific checks for the local gate, called by scripts/gate.sh after its
# lints and before it builds, so they run in pre-push, in the Sandcastle
# sandbox, and by hand.
#
#   gate-checks.sh <merge-base>
#
# <merge-base> is where this branch left origin/main, or empty when there is
# no origin/main. Then the local review can't be checked, so the gate fails
# unless GATE_SKIP_REVIEW=1, in which case every other check runs. Exit
# non-zero to fail the gate.
#
# scripts/gate.sh is Owned by the repo-ci-baseline Template and is overwritten
# on every Apply; this file is Seed, so it belongs to the repo.
set -euo pipefail

base="${1-}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'

# changed <pathspec>...: true when any matching path changed since <base>.
# Deletions count: deleting a module, or the generated review file, is a
# change these checks must see.
changed() {
  [[ -z "$base" ]] && return 0
  ! git diff --quiet --no-renames "$base" HEAD -- "$@"
}

# Hooks run with GIT_DIR and friends set, which confuse git calls made by
# pnpm tooling in a worktree.
run_clean() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX "$@"
}

# The local review (/pre-push-review) must have passed this branch's diff:
# every finding fixed, dismissed or accepted. First, so a push it would refuse
# doesn't wait for the build. GATE_SKIP_REVIEW=1 (that value only) skips it:
# the skill sets it on its own gate runs, and Sandcastle on every gate in its
# sandbox (.sandcastle/lib/skills.mts) until its reviewer runs the same review.
# The check itself also passes a Baseline re-Apply on chore/reapply-baseline
# that changes only Owned files (checkReview in review-ledger.mts).
echo -e "${CYAN}🔎 Local review...${RESET}"
if [[ "${GATE_SKIP_REVIEW:-}" == "1" ]]; then
  echo -e "${GREEN}✅ Local review check skipped (GATE_SKIP_REVIEW=1).${RESET}"
elif [[ -z "$base" ]]; then
  echo "❌ No origin/main to diff against, so the review can't be checked: run git fetch origin main." >&2
  exit 1
else
  run_clean scripts/review.sh check "$base"
fi

# A gh issue or gh pr command without --repo (or -R), a gh repo view without
# a repository argument, or a gh api call on repos/{owner} or repos/:owner,
# reaches gh's default repository, which in a clone whose only remote is a
# fork is the fork. The skills and scripts must name the repository. Each
# command is checked on its own, up to the next backtick, |, ;, &, ) or
# comment, so a flag elsewhere on the line doesn't count. Shell comments are
# skipped, and a command continued with a trailing backslash is read as one
# line (a comment ending in one isn't continued, as in bash). Only files the
# worktree has are read. Cheap enough to run on every gate.
echo -e "${CYAN}🐙 gh commands name their repository...${RESET}"
gh_files=()
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] && gh_files+=("$file")
done < <(git ls-files -z -- .claude/skills scripts)
unnamed=""
if ((${#gh_files[@]} > 0)); then
  unnamed="$(awk '
    # Whether one of the gh commands on `line` names no repository.
    function names_none(line,   rest, command, args) {
      rest = line
      while (match(rest, /(^|[^A-Za-z0-9_-])gh (issue|pr|repo view)([ \t]|$)/)) {
        command = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        args = rest
        if (match(args, /[`|;&)]|[ \t]#/)) args = substr(args, 1, RSTART - 1)
        if (command ~ /repo view/) {
          if (args !~ /^[ \t]*[^- \t]/) return 1
        } else if (args !~ /(^|[ \t])(--repo|-R)([ =]|$)/) {
          return 1
        }
      }
      return 0
    }
    FNR == 1 { held = "" }
    held == "" && /^[ \t]*#/ { next }
    /\\$/ { held = held substr($0, 1, length($0) - 1) " "; next }
    {
      line = held $0
      held = ""
      if (names_none(line) || line ~ /(^|[^A-Za-z0-9_-])gh api [^|;&]*repos\/(\{owner\}|:owner)/) {
        print FILENAME ":" FNR ": " line
      }
    }' "${gh_files[@]}")"
fi
if [[ -n "$unnamed" ]]; then
  echo "❌ These gh commands name no repository, so from a fork's clone they reach the fork. Add --repo mpaulosky/auth0-management-app:" >&2
  echo "$unnamed" >&2
  exit 1
fi
echo -e "${GREEN}✅ Every gh command names its repository.${RESET}"

# .github/copilot-instructions.md is generated from the code-review skill, so
# GitHub's Copilot review and Claude Code review against the same rules.
if changed .claude/skills/code-review/SKILL.md .github/copilot-instructions.md scripts/sync-copilot-review.sh; then
  echo -e "${CYAN}🔁 Copilot review instructions sync...${RESET}"
  scripts/sync-copilot-review.sh --check
else
  echo -e "${GREEN}✅ No Copilot review sync changes to check.${RESET}"
fi

# check-git-hooks.sh is Claude Code's SessionStart hook; ci.yml's "Hook tests"
# job is Owned by the Baseline, so the gate is what runs its test. The test also
# checks the files that wire the hook in, so a change to one reruns it.
if changed scripts/check-git-hooks.sh scripts/tests/check-git-hooks.test.sh .claude/settings.json CLAUDE.md .github/ci/gate-checks.sh; then
  echo -e "${CYAN}🪝 Git hooks SessionStart check tests...${RESET}"
  run_clean bash scripts/tests/check-git-hooks.test.sh
else
  echo -e "${GREEN}✅ No git hooks SessionStart check changes to test.${RESET}"
fi

# branches.test.mts checks Sandcastle's branch names against the branch
# standard, code-review-skill.test.mts checks the code-review skill,
# dockerfile.test.mts checks the sandbox image's linters against the versions
# gate.sh pins, review-ledger.test.mts and gate-checks.test.mts check the
# local review's ledger (and its Owned list against .claude/rules/baseline.md)
# and this file, and pre-push-review-skill.test.mts checks that the review's
# reviewers are read-only, and readme.test.mts checks README.md's Releases
# section, so a change to any of them reruns them.
if changed .sandcastle README.md package.json ':(glob)pnpm-*.yaml' scripts/check-branch-name.sh .claude/skills/code-review scripts/gate.sh \
  scripts/review.sh .github/ci/gate-checks.sh .claude/rules/baseline.md .claude/agents .claude/skills/pre-push-review \
  .claude/settings.json; then
  echo -e "${CYAN}🏰 Sandcastle TypeScript check...${RESET}"
  run_clean pnpm run check:sandcastle
else
  echo -e "${GREEN}✅ No Sandcastle or package changes to check.${RESET}"
fi

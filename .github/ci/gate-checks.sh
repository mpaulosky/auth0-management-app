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

# The local review (/pre-push-review) must have passed this branch's diff,
# with no open Critical or Warning finding (open Advisory findings pass and go
# to the branch's follow-up issue). First, so a push it would refuse
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

# A gh command reaches gh's default repository unless it's told which one,
# and in a clone whose only remote is a fork that's the fork. GH_REPO tells
# every gh command, placeholders in gh api included, whatever their spelling,
# so the skills and scripts run gh with it set: a shell file (a .sh name or a
# #! first line) exports it before its first gh command, and a skill writes
# GH_REPO=mpaulosky/auth0-management-app before each one. gh repo's
# subcommands don't read it, so each takes the repository as its first
# argument (or -R), except list, create and clone, which name their own.
# GH_REPO counts only as a prefix of the gh command itself, or an export
# alone on its line but for a comment, with a value that isn't empty. Text
# that reads gh and a word or flag counts as a command, so prose rewords it,
# and a gh command is kept on one line: a line that continues gh with a
# backslash fails, and so does one that ends in gh, unless it's a shell file
# that has exported GH_REPO (command -v gh). gh repo keeps its subcommand and
# repository on its line. Whole-line comments and the Owned Baseline scripts
# are skipped. Only files the worktree has are read, and a listing that fails
# fails the gate. Cheap enough to run on every gate.
echo -e "${CYAN}🐙 gh commands are told their repository...${RESET}"
# A process substitution's failure is lost, so list once where set -e sees it.
git ls-files -z -- .claude/skills scripts > /dev/null
gh_files=()
while IFS= read -r -d '' file; do
  case "$file" in
    # The Owned Baseline scripts (.claude/rules/baseline.md): this repository
    # can't change them, and the Template checks its own (mpaulosky/dotfiles#267).
    scripts/tests/check-git-hooks.test.sh) ;;
    scripts/gate.sh | scripts/check-branch-name.sh | scripts/check-pr-title.sh | scripts/tests/*) continue ;;
  esac
  [[ -f "$file" ]] && gh_files+=("$file")
done < <(git ls-files -z -- .claude/skills scripts)
untold=""
if ((${#gh_files[@]} > 0)); then
  # q is an apostrophe, which the awk program, in single quotes, can't hold.
  untold="$(awk -v q="'" '
    BEGIN {
      # A value gh receives: quoted and not empty, or bare up to the next blank.
      value = "(\"[^\" \t]+\"|" q "[^" q " \t]+" q "|[^ \t`\"" q ";&|,()<>]+)"
      told = "(^|[^A-Za-z0-9_])GH_REPO=" value "[ \t]+$"
      exports = "^[ \t]*export GH_REPO=" value "[ \t]*(;[ \t]*)?(#.*)?$"
      # gh repo <subcommand>, then its repository: o/r (bare or quoted, not a
      # redirect), <owner>/<repo>, a variable, or -R and --repo.
      named = "^repo[ \t]+[a-z-]+[ \t]+([\"" q "]?[^- \t<>`\"" q "$&|;(][^ \t`<>&|;\"" q "]*/|<[A-Za-z]|\"?[$]|-R[ =]|--repo[ =])"
    }
    FNR == 1 { shell = (FILENAME ~ /\.sh$/ || $0 ~ /^#!/); exported = 0 }
    /^[ \t]*#/ { next }
    shell && $0 ~ exports { exported = 1 }
    # A line that ends in gh, or continues gh onto the next one, leaves its
    # command out of sight. Where GH_REPO is exported, only gh repo needs
    # its words, so a bare gh there (command -v gh) is no command.
    /(^|[^A-Za-z0-9_.-])gh[ \t]*\\$/ || (!(shell && exported) && /(^|[^A-Za-z0-9_.-])gh[ \t]*$/) {
      print FILENAME ":" FNR ": " $0
      next
    }
    {
      rest = $0
      while (match(rest, /(^|[^A-Za-z0-9_.-])gh[ \t]+[a-z-]/)) {
        at = RSTART + (substr(rest, RSTART, 1) == "g" ? 0 : 1)
        before = substr(rest, 1, at - 1)
        rest = substr(rest, at + 2)
        sub(/^[ \t]+/, "", rest)
        # gh repo with no subcommand and repository on its line has none.
        if (rest ~ /^repo([^A-Za-z0-9_-]|$)/) {
          if (rest !~ /^repo[ \t]+(list|create|clone)/ && rest !~ named) {
            print FILENAME ":" FNR ": " $0
            next
          }
        } else if (!(shell && exported) && before !~ told) {
          print FILENAME ":" FNR ": " $0
          next
        }
      }
    }' "${gh_files[@]}")"
fi
if [[ -n "$untold" ]]; then
  echo "❌ These gh commands aren't told their repository, so from a fork's clone they can reach the fork. Run each with GH_REPO=mpaulosky/auth0-management-app: export it at the top of a script, alone on its line but for a comment, or write GH_REPO=mpaulosky/auth0-management-app gh ... in a skill, keeping each gh command on one line. gh repo's subcommands don't read GH_REPO: give the repository as the first argument (or -R)." >&2
  echo "$untold" >&2
  exit 1
fi
echo -e "${GREEN}✅ Every gh command is told its repository.${RESET}"

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
# reviewers are read-only, readme.test.mts checks README.md's Releases
# section, and config.test.mts and watch-pr.test.mts check scripts/watch-pr.sh,
# so a change to any of them reruns them.
if changed .sandcastle README.md package.json ':(glob)pnpm-*.yaml' scripts/check-branch-name.sh .claude/skills/code-review scripts/gate.sh \
  scripts/review.sh .github/ci/gate-checks.sh .claude/rules/baseline.md .claude/agents .claude/skills/pre-push-review \
  .claude/settings.json scripts/watch-pr.sh; then
  echo -e "${CYAN}🏰 Sandcastle TypeScript check...${RESET}"
  run_clean pnpm run check:sandcastle
else
  echo -e "${GREEN}✅ No Sandcastle or package changes to check.${RESET}"
fi

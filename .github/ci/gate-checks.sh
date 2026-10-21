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

# A gh command that names no repository reaches gh's default repository,
# which in a clone whose only remote is a fork is the fork, so the skills and
# scripts must name it: --repo (or -R) on every command group that takes one
# (issue, pr, run, workflow, release, label, secret, variable, cache, browse,
# ruleset), a repository argument to gh repo view, and no {owner}, {repo} or
# repos/:owner placeholder in a gh api call, in its path or its fields. Each
# command is judged by its own arguments: up to the next backtick, |, ;, &, )
# or comment outside quotes, with quoted text and $(...) set aside for the
# flags (a gh command inside $(...) is judged on its own), but kept for gh
# api's placeholders. A bare command group names no command, so it is left
# alone, unless it ends a Markdown line. Whole-line comments are skipped in
# every file, and trailing ones are cut in shell files only (a .sh name or a
# #! first line). A line whose code ends in a backslash is read with the next
# one (a comment ending in one isn't continued, as in bash).
# Only files the worktree has are read, and a listing that fails fails the
# gate. Cheap enough to run on every gate.
echo -e "${CYAN}🐙 gh commands name their repository...${RESET}"
# A process substitution's failure is lost, so list once where set -e sees it.
git ls-files -z -- .claude/skills scripts > /dev/null
gh_files=()
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] && gh_files+=("$file")
done < <(git ls-files -z -- .claude/skills scripts)
unnamed=""
if ((${#gh_files[@]} > 0)); then
  unnamed="$(awk '
    # The arguments a command owns in `s`, the text after it: up to the first
    # terminator outside quotes and $(...), with each quoted string written Q
    # and each $(...) written S, or kept as they are when `keep` is set.
    # \047 is a single quote.
    function own_args(s, keep,   i, c, n, out, q, depth) {
      out = ""
      q = ""
      depth = 0
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (depth > 0) {
          if (keep) out = out c
          if (c == "(") depth++
          else if (c == ")" && --depth == 0 && q == "" && !keep) out = out "S"
          continue
        }
        if (q == "\047") {
          if (keep) out = out c
          if (c == "\047") { q = ""; if (!keep) out = out "Q" }
          continue
        }
        if (c == "$" && substr(s, i + 1, 1) == "(") { depth = 1; if (keep) out = out "$("; i++; continue }
        if (q == "\"") {
          if (keep) out = out c
          if (c == "\"") { q = ""; if (!keep) out = out "Q" }
          continue
        }
        if (c == "\047" || c == "\"") { q = c; if (keep) out = out c; continue }
        if (c ~ /[`|;&)]/) break
        if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t]/)) break
        out = out c
      }
      return out
    }
    # `s` up to its first comment: a # that starts a word outside quotes and
    # $(...).
    function code_of(s,   i, c, n, q, depth) {
      q = ""
      depth = 0
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (depth > 0) {
          if (c == "(") depth++
          else if (c == ")") depth--
          continue
        }
        # As in own_args: $(...) opens inside double quotes, not single.
        if (q == "\047") {
          if (c == q) q = ""
          continue
        }
        if (c == "$" && substr(s, i + 1, 1) == "(") { depth = 1; i++; continue }
        if (q == "\"") {
          if (c == q) q = ""
          continue
        }
        if (c == "\047" || c == "\"") { q = c; continue }
        if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t]/)) return substr(s, 1, i - 1)
      }
      return s
    }
    # Whether one of the gh commands on `line` names no repository.
    function names_none(line,   rest, command, args, first) {
      rest = line
      while (match(rest, /(^|[^A-Za-z0-9_-])gh (issue|pr|run|workflow|release|label|secret|variable|cache|browse|ruleset|repo view|api)/)) {
        command = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        if (substr(rest, 1, 1) ~ /[A-Za-z0-9_-]/) continue
        if (command ~ /api$/) {
          if (own_args(rest, 1) ~ /\{owner\}|\{repo\}|repos\/:owner/) return 1
          continue
        }
        args = own_args(rest)
        first = args
        sub(/^[ \t]+/, "", first)
        if (command ~ /repo view$/) {
          # A redirect is no repository; a <placeholder> in a skill is one.
          # own_args stops at &, so &> leaves no argument at all.
          if (first == "" || first ~ /^-/ || first ~ /^([0-9]*>|<([^A-Za-z]|$))/) return 1
        } else if (first == "") {
          # A bare group, unless it ends a Markdown line, where a code span
          # may go on to its command on the next line.
          if (FILENAME ~ /\.md$/ && rest ~ /^[ \t]*$/) return 1
        } else if (args !~ /(^|[ \t])(--repo|-R)([ =]|$)/) {
          return 1
        }
      }
      return 0
    }
    # A shell file (a .sh name, or a #! first line) has trailing comments to
    # cut; no other file is cut, so an unknown kind is read whole.
    FNR == 1 { held = ""; shell = (FILENAME ~ /\.sh$/ || $0 ~ /^#!/) }
    held == "" && /^[ \t]*#/ { next }
    {
      line = held $0
      if (shell) line = code_of(line)
      # Continued only when its code ends in a backslash: a comment that ends
      # in one is not continued, as in bash.
      if (line ~ /\\$/) { held = substr(line, 1, length(line) - 1) " "; next }
      held = ""
      if (names_none(line)) {
        print FILENAME ":" FNR ": " line
      }
    }' "${gh_files[@]}")"
fi
if [[ -n "$unnamed" ]]; then
  echo "❌ These gh commands name no repository, so from a fork's clone they can reach the fork. Add --repo mpaulosky/auth0-management-app to gh issue, pr, run, workflow, release, label, secret, variable, cache, browse and ruleset; for gh repo view, give the repository as its first argument; for gh api, write it in place of every {owner}, {repo} or :owner: repos/mpaulosky/auth0-management-app/..." >&2
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

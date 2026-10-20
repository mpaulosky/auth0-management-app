#!/usr/bin/env bash
# Tests for scripts/check-git-hooks.sh, the Claude Code SessionStart hook that
# warns when core.hooksPath isn't .github/hooks, and for the places that wire
# it in: .claude/settings.json, .github/ci/gate-checks.sh and CLAUDE.md.
# Usage: scripts/tests/check-git-hooks.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/check-git-hooks.sh"
BASH_BIN="$(command -v bash)"

command -v jq > /dev/null 2>&1 || { echo "check-git-hooks.test.sh needs jq" >&2; exit 1; }

PASSED=0
FAILED=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass() {
  PASSED=$((PASSED + 1))
  echo "ok   - $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL - $1"
  shift
  local line
  for line in "$@"; do echo "       | $line"; done
}

# run_hook <dir> [PATH]: runs the script from <dir> with git's global and
# system config out of the way and no inherited repository variables. Sets
# OUTPUT and STATUS.
run_hook() {
  local dir="$1" path="${2:-$PATH}"
  OUTPUT="$(cd "$dir" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX \
    HOME="$WORK" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_CEILING_DIRECTORIES="$WORK" PATH="$path" "$BASH_BIN" "$SCRIPT" 2>&1)"
  STATUS=$?
}

# new_repo <name> [hooksPath]: a fresh repository with a .github/hooks
# directory, with core.hooksPath set only when a value is given.
new_repo() {
  local dir="$WORK/$1"
  mkdir -p "$dir/.github/hooks"
  git init --quiet "$dir"
  if [[ $# -ge 2 ]]; then
    git -C "$dir" config core.hooksPath "$2"
  fi
  echo "$dir"
}

# expect_warning <label> <dir>: exit 0 and a warning that says the pre-push
# gate won't run and names the fix. Claude Code shows systemMessage to the
# person only when the output parses as JSON.
expect_warning() {
  run_hook "$2"
  local problems=()
  [[ $STATUS -eq 0 ]] || problems+=("exit $STATUS, want 0")
  jq -e '.systemMessage and .hookSpecificOutput.additionalContext' <<< "$OUTPUT" > /dev/null 2>&1 \
    || problems+=("output isn't JSON with systemMessage and hookSpecificOutput.additionalContext")
  [[ "$OUTPUT" == *"pre-push"* ]] || problems+=("output doesn't mention the pre-push gate")
  [[ "$OUTPUT" == *"won't run"* ]] || problems+=("output doesn't say the gate won't run")
  [[ "$OUTPUT" == *"git config core.hooksPath .github/hooks"* ]] || problems+=("output doesn't name the fix")
  if [[ ${#problems[@]} -eq 0 ]]; then
    pass "$1"
  else
    fail "$1" "${problems[@]}" "output: $OUTPUT"
  fi
}

# expect_silent <label> <dir> [PATH]: exit 0 and no output.
expect_silent() {
  run_hook "$2" "${3:-$PATH}"
  if [[ $STATUS -eq 0 && -z "$OUTPUT" ]]; then
    pass "$1"
  else
    fail "$1" "exit $STATUS and output: $OUTPUT" "want exit 0 and no output"
  fi
}

# --- the hook's behaviour ---

expect_warning "hooksPath unset warns" "$(new_repo unset)"
expect_warning "hooksPath empty warns" "$(new_repo empty "")"
expect_warning "hooksPath .githooks warns" "$(new_repo wrong-value .githooks)"
expect_warning "hooksPath .git/hooks warns" "$(new_repo default-dir .git/hooks)"
expect_silent "hooksPath .github/hooks prints nothing" "$(new_repo correct .github/hooks)"
expect_silent "hooksPath .github/hooks/ (trailing slash) prints nothing" "$(new_repo trailing-slash .github/hooks/)"
expect_silent "hooksPath ./.github/hooks prints nothing" "$(new_repo dot-slash ./.github/hooks)"
repo="$(new_repo absolute)"
git -C "$repo" config core.hooksPath "$repo/.github/hooks"
expect_silent "hooksPath as an absolute path to .github/hooks prints nothing" "$repo"

# The setting is shared by a repository's worktrees, and the session may
# start in a subdirectory.
repo="$(new_repo subdir)"
mkdir -p "$repo/src/deep"
expect_warning "hooksPath unset warns from a subdirectory" "$repo/src/deep"
git -C "$repo" config core.hooksPath .github/hooks
expect_silent "hooksPath .github/hooks prints nothing from a subdirectory" "$repo/src/deep"

# Where .git/config can't be written, as in Sandcastle's sandbox, the warning
# can't be acted on, so the hook stays silent.
repo="$(new_repo read-only-config)"
chmod a-w "$repo/.git/config"
if [[ -w "$repo/.git/config" ]]; then
  echo "skip - running as a user who can write a read-only file, so the read-only config case can't be set up"
else
  expect_silent "a read-only .git/config prints nothing" "$repo"
fi
chmod u+w "$repo/.git/config"

# Never fails the session.
mkdir -p "$WORK/not-a-repo"
expect_silent "outside a git repository exits 0 without output" "$WORK/not-a-repo"
mkdir -p "$WORK/no-git-bin"
expect_silent "git missing exits 0 without output" "$(new_repo no-git)" "$WORK/no-git-bin"

# --- the places that wire the hook in ---

settings="$ROOT/.claude/settings.json"
if [[ -f "$settings" ]] && jq -e . "$settings" > /dev/null 2>&1; then
  commands="$(jq -r '.hooks.SessionStart[]?.hooks[]? | select(.type == "command") | .command' "$settings")"
  if [[ "$commands" == *"scripts/check-git-hooks.sh"* ]]; then
    pass ".claude/settings.json registers a SessionStart hook that runs scripts/check-git-hooks.sh"
  else
    fail ".claude/settings.json registers a SessionStart hook that runs scripts/check-git-hooks.sh" "SessionStart commands: $commands"
  fi
else
  fail ".claude/settings.json registers a SessionStart hook that runs scripts/check-git-hooks.sh" "missing or not valid JSON"
fi

if [[ -x "$SCRIPT" ]]; then
  pass "scripts/check-git-hooks.sh is executable"
else
  fail "scripts/check-git-hooks.sh is executable"
fi

# gate-checks.sh must rerun this test when the script or the test changes.
gate_checks="$ROOT/.github/ci/gate-checks.sh"
if grep -q 'changed .*scripts/check-git-hooks\.sh' "$gate_checks" \
  && grep -q 'changed .*scripts/tests/check-git-hooks\.test\.sh' "$gate_checks" \
  && grep -q 'bash scripts/tests/check-git-hooks\.test\.sh' "$gate_checks"; then
  pass ".github/ci/gate-checks.sh runs this test when the script or the test changes"
else
  fail ".github/ci/gate-checks.sh runs this test when the script or the test changes" \
    "want 'changed' on both paths and a 'bash scripts/tests/check-git-hooks.test.sh' call"
fi

# CLAUDE.md's Commands section carries the rule about claiming the gate passed.
# The paragraph wraps, so join its lines before matching.
commands_section="$(awk '/^## Commands/{on=1; next} /^## /{on=0} on' "$ROOT/CLAUDE.md" | tr '\n' ' ')"
if grep -qiE "(don't|do not|never) (report|claim|say)[^.]*pre-push gate[^.]*(passed|passes)[^.]*unless[^.]*All gates passed[^.]*scripts/gate\.sh" <<< "$commands_section"; then
  pass "CLAUDE.md (Commands) says not to report the pre-push gate as passed unless 'All gates passed' was seen"
else
  fail "CLAUDE.md (Commands) says not to report the pre-push gate as passed unless 'All gates passed' was seen" \
    "want one sentence like \"Don't report the pre-push gate as passed unless the hook's 'All gates passed' line was seen, or scripts/gate.sh was run by hand and passed.\""
fi

echo
echo "$PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]

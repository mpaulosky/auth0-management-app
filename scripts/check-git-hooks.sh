#!/usr/bin/env bash
# Claude Code's SessionStart hook (.claude/settings.json): warns when this
# clone's core.hooksPath isn't .github/hooks, because then git never runs
# .github/hooks/pre-push and a push skips the gate without a word.
#
#   scripts/check-git-hooks.sh
#
# Checks the repository the session starts in. Prints nothing when the hooks
# are on. The warning is JSON: systemMessage shows it to the person, and
# additionalContext tells the agent. Always exits 0, so it never stops a
# session: outside a git repository, or without git, it prints nothing.
# Uses only bash builtins and git, so a missing tool can't make it fail.
set -uo pipefail

command -v git > /dev/null 2>&1 || exit 0
[[ "$(git rev-parse --is-inside-work-tree 2> /dev/null)" == true ]] || exit 0

if [[ "$(git config --get core.hooksPath 2> /dev/null)" == .github/hooks ]]; then
  exit 0
fi

# Kept free of double quotes and backslashes, so it goes into the JSON as is.
message="Git hooks are off in this clone: core.hooksPath isn't .github/hooks, so the pre-push gate won't run on a push. Turn them on with: git config core.hooksPath .github/hooks"

printf '{"systemMessage": "⚠️ %s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' \
  "$message" "$message"
exit 0

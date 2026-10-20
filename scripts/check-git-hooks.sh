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
# session: outside a git repository, or without git, it prints nothing. It also
# stays silent where .git/config can't be written (Sandcastle's sandbox).
# Uses only bash builtins and git, so a missing tool can't make it fail.
set -uo pipefail

command -v git > /dev/null 2>&1 || exit 0
[[ "$(git rev-parse --is-inside-work-tree 2> /dev/null)" == true ]] || exit 0

# Git runs the hooks in the directory --git-path resolves, which takes
# core.hooksPath into account in any spelling (trailing slash, ./, absolute,
# relative to a linked worktree), so compare directories, not the setting's text.
# An empty core.hooksPath makes this fail; git runs no hooks then, so warn.
hooks="$(git rev-parse --path-format=absolute --git-path hooks 2> /dev/null)" || hooks=
top="$(git rev-parse --show-toplevel 2> /dev/null)" || exit 0
have=
[[ -n "$hooks" ]] && have="$(cd "$hooks" 2> /dev/null && pwd -P)"
want="$(cd "$top/.github/hooks" 2> /dev/null && pwd -P)"
if [[ -n "$want" && "$have" == "$want" ]]; then
  exit 0
fi

# Sandcastle's sandbox mounts .git/config read-only and pushes with hooks off on
# purpose. Telling an agent there to turn them on is wrong and can't work, and
# neither can a person who can't write the config.
common="$(git rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" || exit 0
[[ -w "$common/config" ]] || exit 0

# Kept free of double quotes and backslashes, so it goes into the JSON as is.
message="Git hooks are off in this clone: core.hooksPath isn't .github/hooks, so the pre-push gate won't run on a push. Turn them on with: git config core.hooksPath .github/hooks"

printf '{"systemMessage": "⚠️ %s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' \
  "$message" "$message"
exit 0

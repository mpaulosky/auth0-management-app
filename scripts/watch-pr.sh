#!/usr/bin/env bash
# Watches a PR until something needs the session that opened it, prints why on
# stdout and exits 0. Run it in the background after opening or pushing to a PR
# (see CLAUDE.md, Git workflow). Exits 2 on bad usage.
#
# It wakes when:
#   - the PR merged or closed;
#   - it has a conflict with main or is behind it;
#   - every check finished and one failed (no checks yet means not finished);
#   - an unresolved review thread's last comment doesn't carry WATCH_PR_MARKER,
#     which the session puts in every reply, so the owner's comments wake it even
#     when the session posts with the owner's token;
#   - a review requests changes, or a person (not a bot) left a review body or a
#     PR comment without the marker, that it hasn't reported before;
#   - nothing changed for WATCH_PR_IDLE_MINUTES (default 30).
#
# Reported review and comment IDs are kept in the git common dir, so a restart
# after a push doesn't report them again.

set -euo pipefail

readonly WATCH_PR_MARKER="<!-- claude-session -->"

pr="${1:-}"
if [[ ! "$pr" =~ ^[0-9]+$ ]]; then
	echo "Usage: scripts/watch-pr.sh <pr-number>" >&2
	exit 2
fi

idle_limit="${WATCH_PR_IDLE_MINUTES:-30}"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
owner="${repo%%/*}"
name="${repo##*/}"
seen_file="$(git rev-parse --git-common-dir)/watch-pr-${pr}.seen"
touch "$seen_file"

# shellcheck disable=SC2016 # GraphQL variables, not shell expansions.
query='query($owner: String!, $name: String!, $pr: Int!) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $pr) {
			state
			mergeable
			mergeStateStatus
			reviewThreads(first: 100) {
				nodes { id isResolved comments(last: 1) { nodes { body } } }
			}
			reviews(last: 50) {
				nodes { id state body author { __typename login } }
			}
			comments(last: 50) {
				nodes { id body author { __typename login } }
			}
		}
	}
}'

last_snapshot=""
idle=0
while true; do
	data="$(gh api graphql -f query="$query" -f owner="$owner" -f name="$name" -F pr="$pr" \
		--jq .data.repository.pullRequest)"

	state="$(jq -r .state <<<"$data")"
	if [[ "$state" != "OPEN" ]]; then
		echo "PR #$pr is $state."
		exit 0
	fi

	merge_state="$(jq -r .mergeStateStatus <<<"$data")"
	if [[ "$(jq -r .mergeable <<<"$data")" == "CONFLICTING" || "$merge_state" == "DIRTY" ]]; then
		echo "PR #$pr has a conflict with main: merge origin/main in its worktree."
		exit 0
	fi
	if [[ "$merge_state" == "BEHIND" ]]; then
		echo "PR #$pr is behind main: merge origin/main in its worktree."
		exit 0
	fi

	threads="$(jq -r --arg m "$WATCH_PR_MARKER" '.reviewThreads.nodes[]
		| select((.isResolved | not) and ((.comments.nodes[0].body // "") | contains($m) | not)) | .id' <<<"$data")"
	if [[ -n "$threads" ]]; then
		echo "Unresolved threads waiting on you:"
		echo "$threads"
		exit 0
	fi

	feedback="$(jq -r --arg m "$WATCH_PR_MARKER" '
		[(.reviews.nodes[]
			| select(.state == "CHANGES_REQUESTED"
				or (.author.__typename != "Bot" and .body != "" and (.body | contains($m) | not)))
			| "review \(.id) by \(.author.login // "ghost") (\(.state))"),
		 (.comments.nodes[]
			| select(.author.__typename != "Bot" and (.body | contains($m) | not))
			| "comment \(.id) by \(.author.login // "ghost")")]
		| .[]' <<<"$data" | grep -vxFf "$seen_file" || true)"
	if [[ -n "$feedback" ]]; then
		echo "New feedback outside review threads:"
		echo "$feedback"
		echo "$feedback" >>"$seen_file"
		exit 0
	fi

	# gh pr checks exits non-zero both when a check failed and when none has
	# registered yet, so read its JSON rather than its exit code.
	checks="$(gh pr checks "$pr" --json name,bucket 2>/dev/null || true)"
	checks="${checks:-[]}"
	pending="$(jq '[.[] | select(.bucket == "pending")] | length' <<<"$checks")"
	failed="$(jq -r '[.[] | select(.bucket == "fail") | .name] | join(", ")' <<<"$checks")"
	if [[ "$(jq length <<<"$checks")" -gt 0 && "$pending" -eq 0 && -n "$failed" ]]; then
		echo "Failed checks on PR #$pr: $failed"
		exit 0
	fi

	snapshot="$merge_state|$checks"
	if [[ "$snapshot" == "$last_snapshot" ]]; then
		idle=$((idle + 1))
	else
		idle=0
		last_snapshot="$snapshot"
	fi
	if ((idle >= idle_limit)); then
		echo "PR #$pr hasn't changed for $idle_limit minutes (merge state $merge_state, $pending checks pending)."
		exit 0
	fi

	sleep 60
done

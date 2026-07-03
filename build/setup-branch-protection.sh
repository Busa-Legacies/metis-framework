#!/usr/bin/env bash
# setup-branch-protection.sh — create the free-tier repo rulesets for the public
# framework repo. RUN THIS ONCE, AFTER the repo is flipped to PUBLIC (#121): repo
# rulesets are free for public repos on a free org, but return 403 while private.
#
# Creates:
#   • branch ruleset on the default branch — require PR + 1 approval + Code-Owner
#     review + dismiss-stale + the core-ci status check + block force-push +
#     linear history + block deletion.
#   • tag ruleset (v*) — block force-push / deletion / non-PR updates of release tags.
#
# Idempotent-ish: it deletes any existing ruleset of the same name first.
# Usage:  REPO=Busa-Legacies/metis-framework bash build/setup-branch-protection.sh
set -euo pipefail
REPO="${REPO:-Busa-Legacies/metis-framework}"
CI_CONTEXT="${CI_CONTEXT:-python}"   # the core-ci.yml job name used as the required check

vis=$(gh repo view "$REPO" --json visibility -q .visibility)
if [ "$vis" != "PUBLIC" ]; then
  echo "ERROR: $REPO is $vis. Repo rulesets are free only on PUBLIC repos (free org)."
  echo "Flip the repo to public first, then re-run." >&2
  exit 1
fi

del_existing() {  # $1 = ruleset name
  local id
  id=$(gh api "repos/$REPO/rulesets" -q ".[] | select(.name==\"$1\") | .id" 2>/dev/null || true)
  [ -n "$id" ] && gh api -X DELETE "repos/$REPO/rulesets/$id" >/dev/null && echo "  (replaced existing '$1')"
}

echo "→ branch ruleset on default branch of $REPO"
del_existing "main-protection"
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<JSON
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "$CI_CONTEXT" } ] } },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "deletion" }
  ]
}
JSON
echo "  ✓ main-protection active"

echo "→ tag ruleset (v*) on $REPO"
del_existing "release-tags"
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<JSON
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" }, { "type": "deletion" } ]
}
JSON
echo "  ✓ release-tags active"
echo "done — verify at: https://github.com/$REPO/settings/rules"

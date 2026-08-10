#!/usr/bin/env bash
# Clear Claude Code's first-run gates in the harness-owned HOME, before any pane
# launches.
#
# Interactive Claude Code on a HOME it has never seen shows three screens in a
# row, none of which is an input box:
#
#   1. "Choose the text style that looks best with your terminal"  (theme picker)
#   2. "Press Enter to continue..."                                (security notes)
#   3. "Is this a project you created or one you trust?"           (trust dialog)
#
# --dangerously-skip-permissions clears none of them; it governs tool calls, not
# onboarding. Measured 2026-08-10 against the workflow's pinned 2.1.220 binary:
# unseeded, the boot's seed line is swallowed by the theme picker and the trunk
# reports "never accepted its brief"; seeded, the pane lands directly on the
# input box and accepts it. Both directions were run - the second measurement is
# what makes the first one mean anything.
#
# This is why the harness owns its HOME (rv2_pane_home) instead of seeding the
# ambient one: the operator's box cleared these gates months ago, so the local
# trial could never reproduce the CI failure, and writing into a live
# ~/.claude.json to fix that would mutate config other sessions are using. One
# HOME, created here, identical on the runner and on the operator's machine.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"

HOME_DIR="$(rv2_pane_home)"
ROOT="$(rv2_root)"
mkdir -p "$HOME_DIR/.claude"

SETTINGS="$HOME_DIR/.claude/settings.json"
CONFIG="$HOME_DIR/.claude.json"

# Gates 1 and 2 live in settings.json. Written with //= semantics so a resumed
# run that already has a settings file keeps whatever is in it.
if [ -f "$SETTINGS" ]; then
  tmp="$(mktemp)"
  jq 'if has("theme") then . else .theme = "dark" end
      | if has("skipDangerousModePermissionPrompt") then .
        else .skipDangerousModePermissionPrompt = true end' \
     "$SETTINGS" >"$tmp" && mv "$tmp" "$SETTINGS"
else
  cat >"$SETTINGS" <<'EOF'
{
  "theme": "dark",
  "skipDangerousModePermissionPrompt": true
}
EOF
fi

# autoUpdates:false is not tidiness.
#
# Measured 2026-08-10 on a fresh HOME: the workflow's hash-pinned 2.1.220 binary
# downloaded and staged 2.1.226 into ~/.local/share/claude/versions, and cloned
# the 6.3MB official plugin marketplace, within seconds of starting. The running
# process stays on the pinned ELF - it is launched by absolute path, not through
# the shim - so the review is still executed by the reviewed binary. But
# setup-claude exists to keep UNREVIEWED code off a machine that holds the relay
# credential and runs the pull request's code, and an updater that fetches a
# newer release on every boot puts it back.
#
# The marketplace half is NOT here, deliberately. The first attempt set
# officialMarketplaceAutoInstallAttempted:true and the marketplace was cloned
# anyway - the binary's own predicate is `if (!Attempted) install; if (Installed)
# skip;` so "attempted" alone falls through into the retry branch. The flag that
# works is the env var CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, set
# in boot-session.sh. A config key that looks like it should work and does not is
# worse than no key at all, so it is gone rather than left in as decoration.
#
# Gate 3 is keyed by WORKSPACE PATH, so it has to name the directories the panes
# actually cd into. boot-session.sh puts every pane in $ROOT; prepare-repo.sh
# puts the code under review at $ROOT/repo, and a crew member that cds there for
# a test run would hit the dialog a second time, mid-review, with no one at the
# keyboard. Both are trusted up front.
if [ -f "$CONFIG" ]; then
  tmp="$(mktemp)"
  jq --arg root "$ROOT" --arg repo "$ROOT/repo" '
      .hasCompletedOnboarding = true
    | .autoUpdates = false
    | .projects = ((.projects // {})
        | .[$root] = ((.[$root] // {}) + {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true})
        | .[$repo] = ((.[$repo] // {}) + {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}))
  ' "$CONFIG" >"$tmp" && mv "$tmp" "$CONFIG"
else
  jq -n --arg root "$ROOT" --arg repo "$ROOT/repo" '
    {
      hasCompletedOnboarding: true,
      autoUpdates: false,
      projects: {
        ($root): {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true},
        ($repo): {hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true}
      }
    }' >"$CONFIG"
fi

# Not a formality. If jq produced something unparseable, Claude Code treats the
# config as absent and every gate comes back - as a boot failure sixty seconds
# later, in a different script, with no mention of this one.
jq -e . "$SETTINGS" >/dev/null || { echo "seed-claude-config: $SETTINGS is not valid JSON" >&2; exit 65; }
jq -e . "$CONFIG"   >/dev/null || { echo "seed-claude-config: $CONFIG is not valid JSON" >&2; exit 65; }

echo "seed-claude-config: HOME=$HOME_DIR (theme, bypass warning, trust for $ROOT and $ROOT/repo)"

#!/usr/bin/env bash
# Install the v2 harness runtime on a GH Actions runner: tmux + jq + the pi
# coding agent (node 22) + the vendored axonhub provider plugin.
#
# claude code is NOT installed here - the workflow reuses the repo's existing
# hash-pinned setup-claude action (which also pins ripgrep). This script owns
# the parts with no existing pinned install.
#
# The workflow runs setup-node 22 first so this script and the later tmux
# panes see node 22 on PATH (pi crashes on node 20 with a webidl crash before
# parsing even --help - probe 2026-08-08).
#
# Usage: v2/install-runner.sh   (run from the review job workspace)
#   Env: RV2_PI_VERSION (default 0.82.0), PI_AXONHUB_API_KEY (optional at
#   install; the workflow injects it into the panes), AXONHUB_BASE_URL.
#   Writes RV2_PI_CLI to $GITHUB_ENV when present, so boot-session.sh can
#   launch pi by literal path.
set -euo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
RV2_PI_VERSION="${RV2_PI_VERSION:-0.82.0}"

# tmux + jq: tmux-on-Actions has precedent in e2e.yml; jq is needed by the
# wrapper and the restore/checkpoint scripts.
if ! command -v tmux >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq tmux jq
fi
tmux -V
jq --version

# pi: installed as a global npm package. Node 22 is required (webidl crash on
# node 20 - probe 2026-08-08); the workflow's setup-node step guarantees it.
if ! command -v node >/dev/null 2>&1; then
  echo "install-runner: node is required (workflow runs setup-node 22 first)" >&2
  exit 70
fi
node -v
if ! npm ls -g "@earendil-works/pi-coding-agent" >/dev/null 2>&1; then
  npm install -g "@earendil-works/pi-coding-agent@$RV2_PI_VERSION"
fi
PI_CLI="$(npm root -g)/@earendil-works/pi-coding-agent/dist/cli.js"
[ -f "$PI_CLI" ] || { echo "install-runner: pi cli not found at $PI_CLI" >&2; exit 70; }
node "$PI_CLI" --version

# Vendored axonhub provider: pi's built-in anthropic provider does not honor
# ANTHROPIC_BASE_URL (probe 2026-08-08), so worker routing through the relay
# needs this plugin. Copy it into the pi config and register it.
PI_CONFIG_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$PI_CONFIG_DIR"
PLUGIN_TARGET="$PI_CONFIG_DIR/plugins/pi-axonhub-models"
if [ ! -e "$PLUGIN_TARGET" ]; then
  cp -r "$V2_DIR/pi-axonhub-models" "$PLUGIN_TARGET"
fi

SETTINGS="$PI_CONFIG_DIR/settings.json"
if [ ! -f "$SETTINGS" ]; then
  cat >"$SETTINGS" <<'JSON'
{
  "packages": [],
  "defaultProvider": "axonhub",
  "defaultModel": "cheap-pool",
  "defaultThinkingLevel": "high"
}
JSON
fi
# Idempotent: ensure the plugin is in the package list and the default provider
# is axonhub. jq edits in place so a pre-existing settings file is preserved.
if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ]; then
  jq '.packages = ((.packages // []) + ["../../../.pi/agent/plugins/pi-axonhub-models"] | unique)
      | .defaultProvider = "axonhub"' "$SETTINGS" >"$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
fi

node "$PI_CLI" install "$PLUGIN_TARGET" >/dev/null 2>&1 || true

# Publish the literal pi CLI path for boot-tmux.sh. A LITERAL PATH is
# mandatory: panes run their own env and a colon-joined PATH inside env -p
# expands by cartesian product, silently truncating the workers' tools.
RV2_PI_CLI="$PI_CLI"
RV2_NODE_BIN="$(dirname "$(command -v node)")"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'RV2_PI_CLI=%s\n' "$RV2_PI_CLI" >>"$GITHUB_ENV"
  printf 'RV2_NODE_BIN=%s\n' "$RV2_NODE_BIN" >>"$GITHUB_ENV"
fi

echo "install-runner: tmux+jq+pi($(node "$PI_CLI" --version))+axonhub plugin ready"
echo "install-runner: RV2_PI_CLI=$RV2_PI_CLI"
echo "install-runner: RV2_NODE_BIN=$RV2_NODE_BIN"

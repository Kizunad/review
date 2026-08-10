#!/usr/bin/env bash
# Install the v2 harness runtime on a GH Actions runner: tmux + jq.
#
# claude code is NOT installed here - the workflow reuses the repo's existing
# hash-pinned setup-claude action (which also pins ripgrep). This script owns
# the parts with no existing pinned install, and after the crew moved to
# cc-review-lite that is only tmux and jq.
#
# What used to be here, and why it is gone (design 5.9): the crew ran on pi, so
# this script global-npm-installed @earendil-works/pi-coding-agent, pinned node
# 22 around a webidl crash on node 20, copied a VENDORED axonhub provider plugin
# into ~/.pi/agent/plugins because pi's built-in anthropic provider ignored
# ANTHROPIC_BASE_URL, rewrote settings.json to register it, and published
# RV2_PI_CLI as a literal path because a pane cannot be trusted to have the
# global npm bin on PATH. Every line of that existed to work around pi. The crew
# is Claude Code now and dials the same relay the trunk does, through the same
# two environment variables, so none of it has anything left to do.
#
# Usage: v2/install-runner.sh   (run from the review job workspace)
set -euo pipefail

# tmux-on-Actions has precedent in e2e.yml; jq is needed by the wrapper and the
# restore/checkpoint scripts.
if ! command -v tmux >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq tmux jq
fi
tmux -V
jq --version

# node is still required: the harness contract authorities (harness/*.mjs) run
# under it, and the fake-mode smoke worker is a node script.
command -v node >/dev/null 2>&1 || {
  echo "install-runner: node is required (the workflow runs setup-node first)" >&2
  exit 70
}
node --version

echo "install-runner: tmux + jq + node ready (crew runs on Claude Code, nothing else to install)"

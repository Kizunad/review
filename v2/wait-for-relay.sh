#!/usr/bin/env bash
# Do not boot three Claude Code sessions into a relay that is refusing everyone.
#
# 2026-08-10, run 31376928375: boot succeeded, the trunk took its brief, and its
# first request came back "API Error: 503 system cpu overloaded (current: 97.2%,
# threshold: 90%)". Claude Code retried ten times over about three minutes, gave
# up, and the run spent the next forty-seven minutes idle. The relay's gate is
# driven by the HOST CPU of the machine running it, which moves on a timescale of
# minutes - so a retry ladder measured in seconds cannot outlast it, however many
# rungs it has.
#
# The check is free. The gate refuses on arrival, BEFORE authentication, so an
# unauthenticated POST gets the same 503 with the same CPU number: no credential
# is sent, no channel is reached, nothing is spent, and the probe cannot perturb
# the pool it is asking about. Verified against the public endpoint on
# 2026-08-10: HTTP 503, {"error":{"message":"system cpu overloaded (current:
# 97.9%, threshold: 90%)"}}.
#
# It WAITS rather than fails. Shedding is transient and a review that starts ten
# minutes late is worth far more than one that never starts. And it boots anyway
# when the budget runs out, because the wait-review nudge loop can now recover a
# review that begins during a shed - giving up here would throw away a run that
# might still succeed.
#
# Whatever it waits is SUBTRACTED from the review timeout, published as
# RV2_RELAY_WAITED_S. Otherwise the pre-wait is added to a 50-minute review
# inside a 60-minute job, and the job gets killed by GitHub - which produces no
# synthesized review.json and no artifact at all, strictly worse than the INFRA
# it was trying to avoid.
set -uo pipefail

V2_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=v2/lib.sh
. "$V2_DIR/lib.sh"
# shellcheck source=v2/gate-probe.sh
. "$V2_DIR/gate-probe.sh"

BUDGET_S="${RV2_RELAY_WAIT_S:-600}"
# Slow on purpose. Each probe is one more arrival-side request against the very
# host that is already over its CPU line, and the gauge it reads is a rolling
# average - polling it every second measures nothing that polling it every thirty
# seconds does not, and adds load to the thing being waited on.
POLL_S="${RV2_RELAY_POLL_S:-30}"

BASE_URL="${ANTHROPIC_BASE_URL:-}"
if [ -z "$BASE_URL" ]; then
  echo "wait-for-relay: ANTHROPIC_BASE_URL is empty - skipping the gate check" >&2
  exit 0
fi

# The probe itself lives in v2/gate-probe.sh, shared with wait-review.sh and covered by
# v2/test-gate-probe.sh. Two callers asking "is the gate open" with two separately-written
# probes is how they end up disagreeing: this one decides whether to BOOT, the other decides
# whether a nudge is worth spending, and a difference in their answers would look like the
# gate changing rather than like the harness asking two different questions.
#
# One behaviour changed in the move and it is deliberate: an edge block or an unparseable body
# is now rc 2 (no usable answer) rather than rc 0. This script already treats rc 2 as "boot
# anyway" - the same outcome - but it no longer records a non-observation as a passing gate,
# which is the mistake that had a sibling tool reporting "the gate never refused" while the
# host sat at 96%.
probe() { rv2_gate_probe; }

waited=0
CURRENT=""   # kept for the messages below; rv2_gate_probe publishes RV2_GATE_CURRENT
while :; do
  probe
  case $? in
    0)
      if [ "$waited" -gt 0 ]; then
        echo "wait-for-relay: gate PASSING after ${waited}s - booting"
      else
        echo "wait-for-relay: gate PASSING - booting"
      fi
      break
      ;;
    1)
      if [ "$waited" -ge "$BUDGET_S" ]; then
        echo "wait-for-relay: still shedding after ${waited}s (${RV2_GATE_CURRENT:-cpu over threshold})"
        echo "wait-for-relay: booting anyway - the nudge loop can recover a review that starts"
        echo "wait-for-relay: during a shed, and giving up here throws away a run that may succeed."
        break
      fi
      echo "wait-for-relay: relay is shedding (${RV2_GATE_CURRENT:-cpu over threshold}) - waited ${waited}s of ${BUDGET_S}s"
      ;;
    *)
      # Unreachable is not shedding. Waiting for a host that is not answering at
      # all would burn the budget on the one case where waiting cannot help.
      echo "wait-for-relay: no answer from the relay - not a CPU refusal, proceeding to boot" >&2
      break
      ;;
  esac
  sleep "$POLL_S"
  waited=$((waited + POLL_S))
done

if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'RV2_RELAY_WAITED_S=%s\n' "$waited" >>"$GITHUB_ENV"
fi
echo "wait-for-relay: waited ${waited}s"
exit 0

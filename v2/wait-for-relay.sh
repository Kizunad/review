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

# 0 = past the CPU gate, 1 = shedding, 2 = no usable answer.
probe() {
  local body code
  body="$(curl -s -m 10 -o /tmp/rv2-relay-probe.$$ -w '%{http_code}' \
    -X POST "${BASE_URL%/}/v1/messages" \
    -H 'content-type: application/json' \
    -d '{"model":"cc-review","max_tokens":1,"messages":[{"role":"user","content":"x"}]}' 2>/dev/null)"
  code="$body"
  body="$(cat "/tmp/rv2-relay-probe.$$" 2>/dev/null || true)"
  rm -f "/tmp/rv2-relay-probe.$$"
  case "$code" in
    000|'') return 2 ;;
  esac
  # Read the BODY, not the status. A 503 can mean many things and only one of
  # them is worth waiting for; treating every 503 as the CPU gate would make the
  # harness wait ten minutes on an outage it cannot wait out.
  if [ "$code" = 503 ] && grep -q 'cpu overloaded' <<<"$body"; then
    CURRENT="$(grep -oE 'current: [0-9.]+%' <<<"$body" | head -1)"
    return 1
  fi
  return 0
}

waited=0
CURRENT=''
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
        echo "wait-for-relay: still shedding after ${waited}s (${CURRENT:-cpu over threshold})"
        echo "wait-for-relay: booting anyway - the nudge loop can recover a review that starts"
        echo "wait-for-relay: during a shed, and giving up here throws away a run that may succeed."
        break
      fi
      echo "wait-for-relay: relay is shedding (${CURRENT:-cpu over threshold}) - waited ${waited}s of ${BUDGET_S}s"
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

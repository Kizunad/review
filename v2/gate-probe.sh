#!/usr/bin/env bash
# One unauthenticated probe of the relay's arrival-side CPU gate. Sourced, not run.
#
# rv2_gate_probe -> 0 past the gate | 1 shedding | 2 no usable answer
#                   sets RV2_GATE_CURRENT to "current: 97.2%" when it can read one.
#
# Lives in its own file rather than lib.sh so that wait-for-relay.sh (which decides whether to
# boot) and wait-review.sh (which decides whether a nudge is worth spending) ask the SAME
# question the same way. They had different stakes and would have grown different probes.
#
# THE PROBE SENDS NO CREDENTIAL. The gate refuses on arrival, before auth, so an unauthenticated
# request gets the same verdict a real one would and reaches no channel and spends nothing. A
# pass answers 401, which is why this reads the BODY and not the status code.

# 0 = past the CPU gate, 1 = shedding, 2 = no usable answer.
rv2_gate_probe() {
  local body code base tmp
  base="${ANTHROPIC_BASE_URL:-}"
  RV2_GATE_CURRENT=''
  [ -n "$base" ] || return 2
  tmp="$(mktemp -t rv2-gate-probe-XXXXXX)"
  code="$(curl -s -m 10 -o "$tmp" -w '%{http_code}' \
    -X POST "${base%/}/v1/messages" \
    -H 'content-type: application/json' \
    -d '{"model":"cc-review","max_tokens":1,"messages":[{"role":"user","content":"x"}]}' 2>/dev/null)"
  body="$(cat "$tmp" 2>/dev/null || true)"
  rm -f "$tmp"
  case "$code" in
    000|'') return 2 ;;
  esac
  # Read the BODY, not the status. A 503 can mean many things and only one of them is worth
  # waiting out; treating every 503 as the CPU gate would make the harness wait on an outage it
  # cannot wait out.
  if [ "$code" = 503 ] && grep -q 'cpu overloaded' <<<"$body"; then
    RV2_GATE_CURRENT="$(grep -oE 'current: [0-9.]+%' <<<"$body" | head -1)"
    return 1
  fi
  # PASS IS A POSITIVE SIGNATURE, NOT A FALLTHROUGH. `*) return 0` counted anything that was not
  # a recognised 503 as the gate letting the request through - which is how an edge block (403
  # "error code: 1010" from Cloudflare, deterministic against some User-Agents) got recorded as
  # a pass in the orchestration-side tooling, and made a tool report "the gate never refused"
  # while the box sat at 96%. A pass is the API answering; anything else is a non-observation.
  if grep -q 'error code: 1010\|Attention Required\|Cloudflare' <<<"$body"; then
    return 2
  fi
  grep -q '"error"\|"type"\|"content"' <<<"$body" || return 2
  return 0
}

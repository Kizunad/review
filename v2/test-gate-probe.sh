#!/usr/bin/env bash
# Does rv2_gate_probe classify what the relay actually says?
#
# This matters more than it looks. wait-review.sh now spends its nudge budget only when the
# probe says the gate is open, so a probe stuck on "shedding" makes every review time out
# without a single nudge, and a probe that calls everything "open" restores the behaviour this
# was written to fix - 21 nudges burned against a door that was shut the whole time
# (run 31391454369, host pinned at 99.4%).
#
# Each case is a real body shape observed in production, served by a local stub, so the test
# exercises the parsing rather than a description of it.
set -uo pipefail
V2_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$V2_DIR/gate-probe.sh"

pass=0; fail=0
check() { # label expected-rc actual-rc [extra]
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %s\n' "$1"
  else fail=$((fail+1)); printf '  FAIL %s (expected rc %s, got %s)\n' "$1" "$2" "$3"; fi
}

PORT="${RV2_TEST_PORT:-8${RANDOM:0:3}}"
STUB="$(mktemp -t rv2-gate-stub-XXXXXX.py)"
BODYFILE="$(mktemp -t rv2-gate-body-XXXXXX)"
CODEFILE="$(mktemp -t rv2-gate-code-XXXXXX)"
cat >"$STUB" <<'PY'
import http.server, os, sys
BODY, CODE = sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        body = open(BODY, 'rb').read()
        self.send_response(int(open(CODE).read().strip()))
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
python3 "$STUB" "$PORT" "$BODYFILE" "$CODEFILE" >/dev/null 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null; rm -f "$STUB" "$BODYFILE" "$CODEFILE"' EXIT
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"

serve() { printf '%s' "$1" >"$BODYFILE"; printf '%s' "$2" >"$CODEFILE"; }
rc_of() { rv2_gate_probe; echo $?; }

for _ in $(seq 1 40); do
  serve '{"error":{"message":"Invalid token"}}' 401
  curl -s -m 1 -o /dev/null -X POST "$ANTHROPIC_BASE_URL/v1/messages" -d '{}' && break
  sleep 0.25
done

echo "1. the CPU gate refusing -> SHED (rc 1), and the number is read off the body"
serve '{"error":{"type":"new_api_error","message":"system cpu overloaded (current: 97.2%, threshold: 90%)"}}' 503
check "503 cpu overloaded" 1 "$(rc_of)"
rv2_gate_probe; check "reports the reading" "current: 97.2%" "$RV2_GATE_CURRENT"

echo "2. an unauthenticated request that got PAST the gate -> PASS (rc 0)"
# A pass answers 401: the gate refuses on arrival, before auth, so reaching auth IS the pass.
serve '{"error":{"code":"","message":"Invalid token provided"}}' 401
check "401 invalid token" 0 "$(rc_of)"
serve '{"type":"message","content":[{"type":"text","text":"x"}]}' 200
check "200 real answer" 0 "$(rc_of)"

echo "3. a 503 that is NOT the CPU gate must not be read as one"
# Waiting out an upstream outage as if it were a shed burns the whole review budget on
# something that will not clear by waiting.
serve '{"error":{"message":"upstream channel unavailable"}}' 503
check "503 without the cpu marker" 0 "$(rc_of)"

echo "4. an EDGE BLOCK is a non-observation (rc 2), never a pass"
# The exact defect that made gate-window.py report "the gate never refused" while the box sat
# at 96%: Cloudflare answers some User-Agents with 403 error code 1010 and the request never
# reaches the gate. Counting that as a pass invents observations that never happened.
serve 'error code: 1010' 403
check "cloudflare 1010" 2 "$(rc_of)"
serve '<html><title>Attention Required! | Cloudflare</title></html>' 403
check "cloudflare interstitial" 2 "$(rc_of)"

echo "5. a body that is not the API answering is a non-observation, not a pass"
serve 'proxy error' 502
check "unrecognised body" 2 "$(rc_of)"

echo "6. nothing listening -> rc 2, and it must not hang"
saved="$ANTHROPIC_BASE_URL"
export ANTHROPIC_BASE_URL="http://127.0.0.1:1"
check "connection refused" 2 "$(rc_of)"
export ANTHROPIC_BASE_URL=""
check "no base url configured" 2 "$(rc_of)"
export ANTHROPIC_BASE_URL="$saved"

echo "7. the probe leaves no temp file behind"
before="$(find /tmp -maxdepth 1 -name 'rv2-gate-probe-*' 2>/dev/null | wc -l)"
serve '{"error":{"message":"Invalid token"}}' 401
rv2_gate_probe
after="$(find /tmp -maxdepth 1 -name 'rv2-gate-probe-*' 2>/dev/null | wc -l)"
check "no leaked probe temp files" "$before" "$after"

echo "8. every caller of rv2_gate_probe actually SOURCES it"
# Not a paranoid check - it caught a live defect the moment it was written. The `source` line
# was added to wait-for-relay.sh by a one-liner guarded with `grep -q gate-probe`, which matched
# the COMMENT about gate-probe.sh and skipped the source. The function would then have been
# undefined at runtime, `probe` would exit 127, the case arm would read that as "no answer from
# the relay", and the script would have booted every time while reporting that the gate check
# had run. A missing function and a passing gate are indistinguishable downstream.
for caller in wait-for-relay.sh wait-review.sh; do
  f="$V2_DIR/$caller"
  if ! grep -q 'rv2_gate_probe' "$f"; then
    continue
  fi
  if grep -qE '^[[:space:]]*\.[[:space:]]+"\$V2_DIR/gate-probe\.sh"' "$f"; then
    pass=$((pass+1)); printf '  ok   %s sources gate-probe.sh\n' "$caller"
  else
    fail=$((fail+1)); printf '  FAIL %s calls rv2_gate_probe but never sources gate-probe.sh\n' "$caller"
  fi
done

echo
echo "$pass ok / $fail FAIL"
[ "$fail" -eq 0 ]

# review engine v2 - runner orchestration harness

The v2 runner design (design doc sections 5.5, 5.7, 5.9): a review that runs ON
a GH Actions runner via a tmux session instead of inside the engine's own
process, and that establishes its findings by DOING things rather than by
reading the diff and reasoning.

Two roles, both Claude Code on one relay:

- **trunk = `cc-review` (sol)** - classifies the diff, decides what each part
  needs in order to be believed, directs the crew, and judges what comes back.
  Writes no code and runs no experiments.
- **crew = `cc-review-lite`** - writes and runs tests, builds the server and
  drives it as a black-box client, drops evidence. Judges nothing.

Modes per assignment: `static` (read and reason - the cheapest, and what the
whole v1 engine did for everything), `test` (a test that fails if the target
regresses), `probe` (build from this head, stand up a minimal but functionally
complete deployment, drive it over the wire). Building is allowed; the earlier
"the pipeline builds nothing" freeze is gone.

Evidence is an INPUT to the trunk's judgement and never a finding by itself -
the final call is sol's and cannot be bypassed (operator, 2026-08-10).

## Architecture

```
workflow_dispatch / workflow_call
   └─ review job (ubuntu-latest, timeout 60m)
       ├─ setup-node 22 + setup-claude (hash-pinned) + install-runner.sh
       ├─ prepare-repo.sh          -> $HARNESS_DIR/repo at PR head
       ├─ build-diff.sh            -> $HARNESS_DIR/diff.txt
       ├─ restore-checkpoint.sh    -> resume from a prior rv2-checkpoint
       ├─ boot-session.sh          -> tmux session:
       │     pane 0: claude -p (trunk)  - orchestrates + judges ONLY
       │     panes 1,2: cc-review-lite  - write + run tests, build + probe,
       │                                  drop evidence
       │     + checkpoint-watchdog.sh (immediate + every N min + trap)
       ├─ wait-review.sh            -> poll output/review.json (timeout -> kill)
       ├─ wrapper.sh                -> validate v2r1 + headOid + evidence
       │                              cross-check; synthesize
       │                              infrastructure_failure on trunk death
       └─ upload-artifact (if: always())  -> rv2-p1 (whole HARNESS_DIR)
```

## State root and data contracts

Everything lives under one state root `HARNESS_DIR` (= `RV2_ROOT`), laid out by
`harness/layout.mjs`:

| Path | Meaning |
|------|---------|
| `ledger.tsv` | 4-col `worker<TAB>assignment<TAB>utc<TAB>status` (append-only) |
| `directives/W<N>.md` | per-worker assignment file written by dispatch.sh |
| `assignments/assignments.json` | shard-diff output: `[{id, paths[], chars, kind}]` |
| `evidence/<assignmentId>.json` | worker evidence - the completion authority |
| `checkpoint/checkpoint.json` | v2-checkpoint.1 doc (ledger + completed) |
| `resume/` | checkpoint candidate + `completed.txt` + `resumed-from.txt` |
| `output/review.json` | final v2r1 verdict the wrapper validates |
| `logs/` | pane transcript + watchdog logs |

The **data contracts are owned by the Node harness** (`harness/*.mjs` +
`schemas/*.json`); the bash scripts in `v2/` are thin shims that delegate to
them so there is exactly one authority for each contract:

- **Evidence** (`harness/evidence.mjs`): `evidence/<id>.json` MUST be named
  `<assignmentId>.json` with EXACT fields
  `{version:"v2-evidence.1", assignmentId, mode, worker, headOid, commands,
  artifacts, exitCodes, verdict, notes, binaryProvenance}`. `mode` ∈
  `static|test|probe|adversarial`, `worker` matches `^W[0-9]{1,2}$`, `headOid`
  must equal the reviewed head, and `test`/`static` evidence requires
  `binaryProvenance: null`. A shard is complete only when its evidence file is
  on disk AND valid.
- **Checkpoint** (`harness/checkpoint.mjs`): `node harness/checkpoint.mjs
  write|resume`, version `v2-checkpoint.1`, key `{pullNumber, headOid,
  enginePin}`. `resume` reads `resume/checkpoint.json`, writes
  `resume/completed.txt` + `resume/resumed-from.txt`, and REJECTS any
  checkpoint whose key mismatches the current run.
- **Review** (`harness/validate-review.mjs`): version `v2r1`, fields
  `{version, decision, headOid, findings, failures, degradations, resumedFrom}`.
  Decision invariants: `infrastructure_failure` ⇒ 0 findings + ≥1 failure;
  `approve` ⇒ 0 failures + all findings minor; `request_changes` ⇒ 0 failures +
  ≥1 finding. Each finding's `evidence` is an OBJECT cross-checked against
  completed evidence on disk.

Trunk and workers talk through the disk, not through the engine:
- trunk -> worker: `v2/dispatch.sh W1 <assignment> TEST "<directive>"` sends
  the ASCII directive into the worker pane (ported from ~/orch/dispatch.sh,
  including the active-worker cap of 2 and the ASCII-only rule). The worker
  writes its evidence file at `evidence/<assignmentId>.json`.
- trunk -> disk: after judging each assignment the trunk runs
  `v2/checkpoint.sh`, so the checkpoint never lags disk state by more than one
  assignment (assignment-level idempotency, 5.7a).

## Env vars

Set by the workflow (`review-v2-p1.yml`):

| Var | Meaning |
|-----|---------|
| `HARNESS_DIR` / `RV2_ROOT` | the single state root (default `$PWD`) |
| `RV2_REPOSITORY` / `PR_NUMBER` / `HEAD_OID` | the PR under review |
| `ENGINE_PIN` | engine pin for the resume key (`github.sha`) |
| `RUN_ID` | this run's id (`github.run_id`) |
| `RV2_WORKFLOW_FILE` | this workflow's file name (for restore queries) |
| `RV2_CHECKPOINT_INTERVAL` | watchdog cadence (default 300s) |
| `RV2_REVIEW_TIMEOUT_S` | wait-review timeout (default 1500s) |
| `RV2_MAX_SHARD_CHARS` | shard size (default 12000, matches v1) |
| `RV2_FAKE` | set to 1 -> boot the deterministic stubs instead of Claude Code (local smoke) |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | the ONE relay, for both roles |
| `RV2_TRUNK_MODEL` / `RV2_WORKER_MODEL` | default `cc-review` / `cc-review-lite` |
| `CLAUDE_EXECUTABLE` | set by setup-claude; boot-session uses it for every pane |

`ANTHROPIC_MODEL` is deliberately NOT set: it applies to every claude process in
the job and would silently override the per-pane `--model` that keeps the two
roles apart. Model policy lives in `rv2_trunk_model` / `rv2_worker_model`.

The workflow fills those two from the SAME place v1 does - the `review_base_url` input (falling
back to `vars.REVIEW_CLAUDE_BASE_URL`) and the `review_api_key` secret (falling back to
`secrets.REVIEW_CLAUDE_API_KEY`).

There used to be FOUR names, because pi needed its own `AXONHUB_BASE_URL` / `PI_AXONHUB_API_KEY`
pair. Those were sourced from secrets that exist in neither Kizunad/review nor Kizunad/Bong, so
every early trial booted with an empty relay and died two minutes later as "trunk pane never came
alive" - three CI trials burned on a message that named nothing. Two names for one relay is how a
pair goes empty unnoticed; there is one pair now, and `rv2_require_relay` refuses up front with
EX_CONFIG and names the empty variable.

A `workflow_dispatch` smoke trial only sees secrets defined on the repo that OWNS the workflow.
Kizunad/review currently has none, so standalone trials need either a secret defined there or a
thin caller in Bong passing `secrets.REVIEW_CLAUDE_API_KEY`.

## Local smoke (no relay, no tmux UI)

```bash
# fake workers simulate the cheap pool end-to-end:
node --test test/v2-runner-orchestration.test.mjs   # includes the full loop
# or manually:
HARNESS_DIR=/tmp/rv2-smoke HEAD_OID=$(printf 'a%.0s' {1..40}) \
  node fake/worker.mjs W1
```

## Smoke trial

```bash
gh workflow run review-v2-p1.yml --ref feat/v2-runner-orchestration \
  -f repository=Kizunad/review -f pull_number=<N> -f head_oid=<sha>
```

Artifacts upload with `if: always()`, so even a dead trunk produces an
`rv2-p1` artifact with `checkpoint.json` and a synthesized
`decision=infrastructure_failure` review.json.

## Resume (5.7c)

Restore queries prior runs of THIS workflow at the same head sha, downloads the
`rv2-p1` artifact's `checkpoint/checkpoint.json`, and asks
`harness/checkpoint.mjs resume` to accept-or-reject it. The resume key is
`{pullNumber, headOid, enginePin}`; ANY mismatch invalidates the checkpoint
(enginePin = the commit this workflow ran at, so a different engine commit
invalidates prior checkpoints). The trunk skips shards listed in
`completedAssignments` and records `resumedFrom` in review.json.
`degradations[]` is reserved for the P2 instability ladder.

## Open items (probed)

- ~~**pi needs node 22**~~, ~~**pi ignores `ANTHROPIC_BASE_URL`**~~ - both
  RETIRED 2026-08-10 with pi itself (design 5.9). The crew is `cc-review-lite`,
  so the global npm install, the node-22 pin, the vendored axonhub plugin, the
  second pair of relay names, and `RV2_PI_CLI` are all gone. Every one of them
  existed to work around pi.
- **claude honors `ANTHROPIC_BASE_URL`** (probe 2026-08-08) - both roles dial
  the relay directly; the auth token is carried as Bearer.
- **the crew needs `--dangerously-skip-permissions`** - it exists to build,
  run, and probe. A permission prompt in an unattended pane is a hang, and a
  tool whitelist is what made v1 a read-only reasoner. The sandbox is the
  ephemeral runner VM (design 5.5), not a flag list.
- **leak detection is output-side only** (operator ruling 2026-08-10) - the
  relay node is ours, so probe mode gets no key isolation or separate quota.
  `v2/scan-leaks.sh` scans crew output for the live token and for
  credential-shaped strings, reports file/line/6-char-prefix, and **warns
  without blocking**. It must never print what it finds: a scanner that echoes
  a secret into the CI log has moved it somewhere with longer retention than
  the artifact it was protecting.
- **claude CLI install on the runner** - reuses the repo's hash-pinned
  `.github/actions/setup-claude` (CLAUDE_EXECUTABLE absolute path). No separate
  install needed.
- **trunk model id** - the relay's model list decides; set `trunk_model` input
  to a model the relay serves, or leave empty for the relay default.
- **workflow_call engine pin** - `ENGINE_PIN=github.sha` is correct for
  workflow_dispatch smoke trials; under workflow_call `github.sha` is the
  caller's sha, so callers must pass `engine_ref` explicitly and the pin
  semantics need re-checking before production.

# review engine v2 - P1 runner orchestration harness

Prototype of the v2 runner design (design doc sections 5.5 + 5.7): a review
that runs ON a GH Actions runner via a tmux session instead of inside the
engine's own process. P1 = TEST MODE: only script/knowledge files are
dispatched, nothing is built.

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
       │     panes 1,2: pi (workers)    - write + run tests, drop evidence
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
| `RV2_FAKE` | set to 1 -> boot fake/worker.mjs instead of pi (local smoke) |
| `AXONHUB_BASE_URL` / `PI_AXONHUB_API_KEY` | relay for the trunk + pi workers |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` | trunk |
| `CLAUDE_EXECUTABLE` | set by setup-claude; boot-session uses it for the trunk |

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

- **pi needs node 22** - pi 0.82.0 crashes with a webidl error on node 20
  before parsing `--help` (probe 2026-08-08). The job pins node 22.
- **pi ignores `ANTHROPIC_BASE_URL`** - its built-in anthropic provider always
  dials api.anthropic.com (probe 2026-08-08: mock relay received zero requests
  while pi returned a real Anthropic 401). Worker routing therefore uses the
  vendored axonhub plugin (`v2/pi-axonhub-models/`), which registers an
  `openai-completions` provider at `${AXONHUB_BASE_URL}/v1`.
- **claude -p honors `ANTHROPIC_BASE_URL`** (probe 2026-08-08) - the trunk can
  be pointed at the relay directly; the auth token is carried as Bearer.
- **claude CLI install on the runner** - reuses the repo's hash-pinned
  `.github/actions/setup-claude` (CLAUDE_EXECUTABLE absolute path). No separate
  install needed.
- **trunk model id** - the relay's model list decides; set `trunk_model` input
  to a model the relay serves, or leave empty for the relay default.
- **workflow_call engine pin** - `ENGINE_PIN=github.sha` is correct for
  workflow_dispatch smoke trials; under workflow_call `github.sha` is the
  caller's sha, so callers must pass `engine_ref` explicitly and the pin
  semantics need re-checking before production.

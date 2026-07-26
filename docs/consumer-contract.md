# Consumer contract

This document defines the boundary between a caller repository and `Kizunad/review`.

## Immutable invocation

The caller owns its event filters and trusted-author gate. It must invoke the reusable workflow by a complete 40-character commit SHA:

```yaml
permissions: {}

jobs:
  central-review:
    if: <caller-owned exact trigger and association gate>
    permissions:
      actions: read
      contents: read
      pull-requests: write
      issues: write
    uses: Kizunad/review/.github/workflows/review.yml@<40-character-reviewed-commit>
    with:
      pr_number: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
      policy_path: .github/review-policy/project.v1.json
      review_base_url: ${{ vars.REVIEW_CLAUDE_BASE_URL }}
      shadow: false
    secrets:
      review_api_key: ${{ secrets.REVIEW_CLAUDE_API_KEY }}
```

The caller must not use `@main`, a tag, a short SHA, `secrets: inherit`, or a caller-controlled action/workflow ref. The referenced central commit is the release and rollback unit. The reusable workflow reads the current run-attempt metadata from GitHub's Actions API, requires exactly one `Kizunad/review/.github/workflows/review.yml@<full SHA>` entry whose path and reported SHA agree, and verifies the central checkout OID before running central code. This requires `actions: read` only in the preflight job; the provider-bearing review job remains limited to repository read permissions.

## Inputs

| Input | Type | Required | Contract |
|---|---:|---:|---|
| `pr_number` | number | yes | Positive pull-request number in the caller repository. The central workflow re-fetches the PR; this is not accepted as identity proof. |
| `policy_path` | string | yes | Repository-relative regular file from the trusted caller base OID. Absolute paths, `..`, NUL, symlinks, and PR-head replacements are rejected. |
| `review_base_url` | string | yes | HTTPS Claude-compatible gateway base URL. The value is injected as `ANTHROPIC_BASE_URL`; it is never placed in prompts or artifacts. |
| `shadow` | boolean | no | Marks the result as non-gating during migration. Shadow comments and artifacts remain bound to the reviewed OIDs. |
| `max_diff_chars` | number | no | Upper bound for each immutable diff batch given to a Terra finder. Diffs larger than this budget are deterministically split before finders run; raising it expands per-process cost and prompt-injection surface and should be reviewed. |
| `max_shard_chars` | number | no | Upper bound for each immutable diff assignment given to a Luna summarizer. It must not exceed `max_diff_chars`. The platform separately rejects raw diffs above its fixed 262,144-byte safety limit and emits a bound infrastructure-failure artifact instead of attempting review. |
| `worker_timeout_ms` | number | no | Per-process timeout enforced outside Claude Code. |
| `circuit_manual_retry` | boolean | no | Defaults to `false`. When `true`, only a trusted `workflow_dispatch` run bypasses an open infrastructure circuit; other trigger types and comment commands remain circuit-protected. |

Model routing is a platform invariant rather than caller input: `sol` is the Opus alias, `terra` the Sonnet alias, and `luna` the Haiku alias. Every worker runs at `--effort max`.

## Secret

| Secret | Required | Contract |
|---|---:|---|
| `review_api_key` | yes | Caller-owned provider credential mapped to `ANTHROPIC_API_KEY` only in the read-only review job. It is not inherited, persisted, uploaded, placed in prompts, or available to the finalizer. |

The central repository never owns the caller's provider credential. Rotating the caller secret does not require a central release.

## Policy file

The policy is read from the exact caller base OID before the PR head is checked out. It contains domain rules that do not belong in the central taxonomy, for example architecture boundaries, canonical helpers, generated-contract requirements, product invariants, or severity policy.

A policy must be a bounded UTF-8 JSON object with:

```json
{
  "version": "project-review-policy.v1",
  "project": "owner/repository",
  "rules": [
    {
      "id": "canonical-invariant",
      "severity": "major",
      "text": "Describe a concrete, reviewable invariant."
    }
  ],
  "minorFindingsRequestChanges": true
}
```

Rules must be declarative review data. A policy cannot configure tools, commands, runners, action refs, shell, model names, arbitrary paths, hooks, MCP servers, or executable code. Its SHA-256 is recorded in the result manifest and comment.

## Identity and checkout

The workflow resolves the immutable central implementation from GitHub's current run-attempt `referenced_workflows` metadata, then obtains caller repository identity, `baseRefOid`, and `headRefOid` from the GitHub API. The central workflow reference must identify exactly `Kizunad/review/.github/workflows/review.yml` at a lowercase 40-character SHA, and the checked-out central commit must match that SHA. Both caller OIDs must also be lowercase 40-character Git object IDs.

The workflow stages the central runner and caller policy from trusted revisions, then checks out the exact PR head detached. Review proceeds only when `git rev-parse HEAD` equals the authoritative head OID. Before a Claude process receives the provider credential, the platform copies regular repository files into a temporary snapshot, rejects all symlinks and non-regular entries, and excludes `.git`, `.claude`, `.mcp.json`, `CLAUDE.md`, and `AGENTS.md`. Each worker then enters a root-owned, hash-pinned setuid Bubblewrap mount namespace, avoiding dependence on Ubuntu 24.04 unprivileged-user-namespace policy. Only the snapshot is mounted read-only at `/workspace`, alongside the SHA-256-verified native Claude and ripgrep executables installed without package scripts, a minimal read-only runtime, DNS/TLS material, an empty `/home`, and an ephemeral `/tmp`; the original checkout and runner workspace are not mounted, and `/proc/self/environ` plus `/proc/1/environ` are masked. Claude starts with `--safe-mode --disable-slash-commands --strict-mcp-config`, an empty MCP configuration, and path-scoped allow rules for `Read`, `Glob`, and `Grep` under `/workspace` only. Native regression tests verify that safe mode advertises exactly those repository tools, normal `/workspace` Grep remains functional, and exact/concurrent procfs credential-oracle attempts fail without returning credential bytes. The finalizer re-fetches the PR and refuses to publish a normal verdict if either OID changed.

## Artifact contract

The review job uploads exactly the platform-defined outcome, Markdown, and manifest files under a run/attempt-specific artifact name. The manifest binds the run ID, run attempt, immutable central workflow SHA, trusted policy SHA-256, PR OIDs, and the exact bytes of both published artifacts. The finalizer rejects:

- missing, duplicate, or extra files;
- symlinks, non-regular files, path traversal, or size-limit violations;
- malformed or unknown schema versions;
- repository, PR, run, workflow SHA, base OID, or head OID mismatch;
- content whose SHA-256 differs from the signed manifest fields;
- results produced for a stale PR head.

Infrastructure failures are explicit outcomes and fail the stable review check; they are not converted into approval or findings. Validator confirmations are countable only when the same vote marks the defect reachable; semantically contradictory confirmation votes are discarded and their seats are retried. The platform also maintains a caller-owned GitHub issue as a trusted failure log: three distinct run-attempt infrastructure failures within one hour open a one-hour automatic circuit. Circuit state reads fail open, and an exact trusted `/review` issue comment bypasses the circuit for a manual retry. A caller may also set `circuit_manual_retry: true` for a trusted `workflow_dispatch` canary; that opt-in has no effect for any other event or comment command. An automatic run skipped by an open circuit remains a failing non-verdict check, so required review protection cannot turn green without a review. Gate failures never enter the circuit count.

## Upgrade and rollback

1. Review a central release commit and its tests.
2. Replace the caller's pinned 40-character SHA in a normal PR.
3. Run consumer static tests that reject floating refs, `secrets: inherit`, broad permissions, and trigger drift.
4. Observe shadow or canary runs before making a new check required.
5. Roll back by restoring the previous verified full SHA. Never use a floating ref as an emergency bypass.

## Fork pull requests

The workflow must remain safe when PR code is fully attacker-controlled. It never executes caller-head scripts, project builds, package installation, hooks, repository Claude configuration, MCP configuration, or user memory. Symlinks and special files are rejected instead of followed. Claude Code can see only regular caller files in the read-only sanitized snapshot and cannot resolve absolute paths into the original checkout or runner workspace; the only write-capable process is the trusted finalizer after artifact and OID verification.

The finalizer re-fetches PR OIDs immediately before validating and posting. GitHub's issue-comment API has no atomic expected-head precondition, so a narrow refetch-to-POST race cannot be eliminated; any subsequent run is still bound to its own exact head, run attempt, and artifact hashes.

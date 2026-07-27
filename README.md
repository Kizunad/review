# Central Claude Code Review

`Kizunad/review` is a reusable GitHub Actions review platform. A caller repository keeps its trigger and domain policy while this repository owns the versioned Claude Code orchestration, schemas, taxonomy, artifact verification, and finalization logic.

## Review topology

1. A fresh `sol` worker assigns immutable diff shards to one or more `luna` workers.
2. Fresh `luna` workers summarize their assigned shards. They do not produce findings or verdicts.
3. Fresh `terra` finders receive one bounded diff batch, validated Luna summaries, one taxonomy dimension, and the caller policy. Larger diffs are split across fresh finders for every dimension without dropping content. Sol output and transcripts are never forwarded.
4. Every deduplicated candidate receives five valid votes from fresh `terra` validators per round. A confirmation is valid only when the validator also proves the candidate reachable.
5. Four or five confirmations accept; four or five rejections reject; a 2/3 split revotes with five fresh validators for at most three rounds.
6. Only a third split round is sent to a fresh `sol` adjudicator. Infrastructure and schema failures never count as votes.

Every Claude Code process is sessionless and read-only. It runs inside a root-owned, hash-pinned setuid Bubblewrap mount namespace that does not depend on Ubuntu 24.04 unprivileged-user-namespace policy. The namespace exposes only the sanitized caller snapshot at `/workspace`, the pinned Claude executable, a minimal read-only runtime, DNS/TLS files, an empty `/home`, and an ephemeral `/tmp`; `/proc` environment aliases are hidden before the provider credential enters the process. The caller snapshot itself excludes repository `.claude`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.git`, every symlink, and every non-regular file:

```text
bwrap --unshare-all --share-net --as-pid-1 ... \
  --ro-bind <sanitized-snapshot> /workspace \
  --ro-bind <pinned-claude> /sandbox/claude \
  --chdir /workspace --clearenv ... -- \
/sandbox/claude --safe-mode --disable-slash-commands --no-chrome \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  -p <prompt> --no-session-persistence \
  --model sol|terra|luna --effort max \
  --tools Read,Glob,Grep \
  --allowedTools 'Read(//workspace/**),Glob(//workspace/**),Grep(//workspace/**)' \
  --permission-mode dontAsk --output-format json \
  --json-schema '<inline JSON Schema>'
```

## Trust model

- Public workflow and action references must be pinned to a complete 40-character commit SHA. Preflight resolves the called central revision from GitHub's current run-attempt `referenced_workflows` metadata, requires the canonical `Kizunad/review/.github/workflows/review.yml@<SHA>` path and reported SHA to agree, then verifies the central checkout OID.
- The caller's base and head OIDs are read from GitHub and checked before review and again before publication.
- Pull-request files are copied into a temporary read-only review snapshot; repository scripts, symlinks, `.git`, hooks, MCP configuration, skills, `CLAUDE.md`, and `AGENTS.md` are excluded before Claude starts. Bubblewrap then makes that snapshot the only repository tree visible to Claude, so absolute paths cannot recover the original checkout or runner workspace.
- The review job has no GitHub write permission. The finalizer is the only job that can publish a comment.
- Provider credentials are never placed in prompts, artifacts, or diagnostics. Although Claude needs the provider credential for its HTTPS requests, repository tools are permission-scoped to `/workspace`; native regression tests force exact and concurrent `Read`/`Glob`/`Grep` attempts against procfs credential paths and require them to fail without returning credential bytes.
- GitHub credentials are removed from every Claude child process.
- Review artifacts are schema-checked and cryptographically bound to the exact repository, PR, run ID, run attempt, workflow revision, policy SHA-256, base OID, and head OID.
- Provider, CLI, timeout, schema, stale-head, and artifact failures fail closed as infrastructure failures rather than fabricated code findings.
- Raw diffs are read with a fixed 1,048,576-byte (1 MiB) UTF-8 safety bound. The lower caller budgets count JavaScript UTF-16 code units and control each Luna shard and Terra finder batch rather than rejecting the complete diff before deterministic sharding; absolute-limit failures still produce bound infrastructure artifacts.

## Repository layout

- `.github/workflows/review.yml` — reusable workflow.
- `.github/actions/setup-claude/action.yml` — SHA-256-verifies and installs the reviewed native Claude Code binary without package scripts.
- `.claude/skills/code-review/SKILL.md` — strict maintainability review policy.
- `catalog/review-dimensions.v1.json` — provider-neutral review taxonomy.
- `schemas/` — strict stage and artifact contracts.
- `src/` — deterministic orchestration, caller snapshot, circuit breaker, and trust-boundary modules.
- `test/` — Node built-in tests for process, vote, OID, workspace, artifact, and workflow contracts.
- `docs/consumer-contract.md` — caller integration and upgrade contract.

## Development

Node.js 24 or newer is required. Runtime code intentionally has no npm dependencies.

```bash
npm test
node --check src/*.mjs
```

The provider secret belongs to each caller repository. This repository never stores or inherits caller secrets.

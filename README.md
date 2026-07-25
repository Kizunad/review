# Central Claude Code Review

`Kizunad/review` is a reusable GitHub Actions review platform. A caller repository keeps its trigger and domain policy while this repository owns the versioned Claude Code orchestration, schemas, taxonomy, artifact verification, and finalization logic.

## Review topology

1. A fresh `sol` worker assigns immutable diff shards to one or more `luna` workers.
2. Fresh `luna` workers summarize their assigned shards. They do not produce findings or verdicts.
3. Fresh `terra` finders receive only the diff, validated Luna summaries, one taxonomy dimension, and the caller policy. Sol output and transcripts are never forwarded.
4. Every deduplicated candidate receives five valid votes from fresh `terra` validators per round.
5. Four or five confirmations accept; four or five rejections reject; a 2/3 split revotes with five fresh validators for at most three rounds.
6. Only a third split round is sent to a fresh `sol` adjudicator. Infrastructure and schema failures never count as votes.

Every Claude Code process is sessionless and read-only:

```text
claude --bare -p <prompt> --no-session-persistence \
  --model sol|terra|luna --effort max \
  --tools Read,Glob,Grep --allowedTools Read,Glob,Grep \
  --permission-mode dontAsk --output-format json \
  --json-schema '<inline JSON Schema>'
```

## Trust model

- Public workflow and action references must be pinned to a complete 40-character commit SHA.
- The caller's base and head OIDs are read from GitHub and checked before review and again before publication.
- Pull-request code is only read; caller scripts, hooks, MCP configuration, skills, and `CLAUDE.md` are not executed.
- The review job has no GitHub write permission. The finalizer is the only job that can publish a comment.
- GitHub credentials are removed from every Claude child process.
- Review artifacts are schema-checked and cryptographically bound to the exact repository, PR, run, workflow revision, base OID, and head OID.
- Provider, CLI, timeout, schema, stale-head, and artifact failures fail closed as infrastructure failures rather than fabricated code findings.

## Repository layout

- `.github/workflows/review.yml` — reusable workflow.
- `.claude/skills/code-review/SKILL.md` — strict maintainability review policy.
- `catalog/review-dimensions.v1.json` — provider-neutral review taxonomy.
- `schemas/` — strict stage and artifact contracts.
- `src/` — deterministic orchestration and trust-boundary modules.
- `test/` — Node built-in tests for process, vote, OID, workspace, artifact, and workflow contracts.
- `docs/consumer-contract.md` — caller integration and upgrade contract.

## Development

Node.js 24 or newer is required. Runtime code intentionally has no npm dependencies.

```bash
npm test
node --check src/*.mjs
```

The provider secret belongs to each caller repository. This repository never stores or inherits caller secrets.

# Security Policy

## Supported versions

Only immutable commits explicitly pinned by a caller are supported. Callers should upgrade by reviewing and replacing the full 40-character workflow commit SHA. Floating branches and tags are not security boundaries.

## Reporting a vulnerability

Please report vulnerabilities through GitHub's private security-advisory flow for this repository. Do not include provider keys, GitHub tokens, private source, or exploit payloads in a public issue.

A useful report includes:

- the affected commit SHA;
- the trust boundary or workflow stage involved;
- a minimal reproduction using synthetic data;
- the expected fail-closed behavior;
- whether credentials, PR write access, artifact integrity, or stale OIDs are affected.

## Security invariants

Changes must preserve all of the following:

- PR-controlled code is never executed by the review workflow.
- Claude workers receive only `Read`, `Glob`, and `Grep`; no shell or mutation tools.
- Every worker is a fresh, non-persistent Claude Code process.
- Provider credentials exist only in the read-only review job and are removed from child logs and returned errors.
- GitHub write permission exists only in the trusted finalizer.
- The finalizer re-fetches the PR and refuses stale base/head OIDs.
- Artifact files, schemas, sizes, paths, and SHA-256 hashes are verified before publication.
- Invalid model output, missing valid votes, timeouts, CLI failures, and provider failures are infrastructure failures, never code findings or approvals.
- Reusable workflows and third-party actions are referenced by full commit SHA.

Security-sensitive changes require tests that demonstrate both the valid path and the fail-closed path.

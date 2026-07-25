import { canonicalJson, parsePullRequest, sha256 } from './pr-context.mjs';

const ARTIFACT_FILES = ['review.json', 'review.md'];
const REQUIRED = ['version', 'repository', 'pullNumber', 'runId', 'runAttempt', 'workflowRef', 'baseOid', 'headOid', 'reviewOid', 'policySha256', 'artifacts', 'manifestSha256'];
const SHA256 = /^[0-9a-f]{64}$/;

function assertExactKeys(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...required].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields do not match the v1 contract`);
  }
}

function artifactHashes(artifacts) {
  assertExactKeys(artifacts, ARTIFACT_FILES, 'artifacts');
  return Object.fromEntries(ARTIFACT_FILES.map((file) => {
    const content = artifacts[file];
    if (typeof content !== 'string' || content.length === 0) throw new Error(`${file} must be non-empty`);
    return [file, sha256(content)];
  }));
}

function assertManifestFields(manifest) {
  if (manifest.version !== 1) throw new Error('manifest version must be 1');
  if (!Number.isSafeInteger(manifest.runId) || manifest.runId <= 0) throw new Error('manifest run ID must be a positive integer');
  if (!Number.isSafeInteger(manifest.runAttempt) || manifest.runAttempt <= 0) throw new Error('manifest run attempt must be a positive integer');
  if (typeof manifest.policySha256 !== 'string' || !SHA256.test(manifest.policySha256)) {
    throw new Error('manifest policySha256 must be a lowercase SHA-256');
  }
  if (typeof manifest.workflowRef !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.workflowRef)) {
    throw new Error('manifest workflow ref must be a lowercase 40-character commit SHA');
  }
  if (typeof manifest.reviewOid !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.reviewOid)) {
    throw new Error('manifest review OID must be a lowercase 40-character commit SHA');
  }
  assertExactKeys(manifest.artifacts, ARTIFACT_FILES, 'manifest artifacts');
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) throw new Error(`manifest ${file} hash must be a lowercase SHA-256`);
  }
  if (typeof manifest.manifestSha256 !== 'string' || !SHA256.test(manifest.manifestSha256)) {
    throw new Error('manifestSha256 must be a lowercase SHA-256');
  }
}

export function createManifest({ context, runId, runAttempt, workflowRef, reviewOid, policySha256, artifacts }) {
  const pr = parsePullRequest(context);
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error('run ID must be a positive integer');
  if (!Number.isSafeInteger(Number(runAttempt)) || Number(runAttempt) <= 0) throw new Error('run attempt must be a positive integer');
  if (typeof policySha256 !== 'string' || !SHA256.test(policySha256)) throw new Error('policySha256 must be a lowercase SHA-256');
  if (typeof workflowRef !== 'string' || !/^[0-9a-f]{40}$/i.test(workflowRef)) {
    throw new Error('workflow ref must be immutable 40-character commit SHA');
  }
  const manifest = {
    version: 1,
    repository: pr.repository,
    pullNumber: pr.pullNumber,
    runId: Number(runId),
    runAttempt: Number(runAttempt),
    workflowRef: workflowRef.toLowerCase(),
    baseOid: pr.baseOid,
    headOid: pr.headOid,
    reviewOid: reviewOid.toLowerCase(),
    policySha256,
    artifacts: artifactHashes(artifacts),
  };
  if (manifest.reviewOid !== manifest.headOid) throw new Error('review OID must equal the API-fetched head OID');
  return { ...manifest, manifestSha256: sha256(canonicalJson(manifest)) };
}

export function verifyManifest(manifest, expected, artifacts, binding = {}) {
  assertExactKeys(manifest, REQUIRED, 'manifest');
  assertManifestFields(manifest);
  const recomputed = sha256(canonicalJson(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestSha256'))));
  if (manifest.manifestSha256 !== recomputed) throw new Error('manifest hash does not match contents');
  const measured = artifactHashes(artifacts);
  for (const file of ARTIFACT_FILES) {
    if (manifest.artifacts[file] !== measured[file]) throw new Error(`${file} hash does not match manifest`);
  }
  const actual = parsePullRequest(manifest);
  const wanted = parsePullRequest(expected);
  for (const key of ['repository', 'pullNumber', 'baseOid', 'headOid']) {
    if (actual[key] !== wanted[key]) throw new Error(`manifest ${key} does not match current pull request`);
  }
  if (binding.runId !== undefined && manifest.runId !== Number(binding.runId)) throw new Error('manifest runId does not match current workflow run');
  if (binding.runAttempt !== undefined && manifest.runAttempt !== Number(binding.runAttempt)) throw new Error('manifest runAttempt does not match current workflow attempt');
  if (binding.workflowRef !== undefined && manifest.workflowRef !== String(binding.workflowRef).toLowerCase()) throw new Error('manifest workflowRef does not match current workflow ref');
  if (binding.policySha256 !== undefined && manifest.policySha256 !== binding.policySha256) throw new Error('manifest policySha256 does not match trusted policy');
  if (manifest.reviewOid !== wanted.headOid) throw new Error('artifacts were not reviewed at the current head OID');
  return true;
}

import { createHash } from 'node:crypto';

const SHA = /^[0-9a-f]{40}$/i;
const POSITIVE_INT = /^[1-9]\d*$/;

export function assertOid(value, label = 'OID') {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${label} must be a 40-character hexadecimal Git OID`);
  }
  return value.toLowerCase();
}

export function assertRepository(value, label = 'repository') {
  if (typeof value !== 'string' || !/^[\w][\w.-]*\/[\w][\w.-]*$/.test(value)) {
    throw new Error(`${label} must be an owner/repository slug`);
  }
  return value;
}

export function assertPullNumber(value) {
  const normalized = String(value);
  if (!POSITIVE_INT.test(normalized)) {
    throw new Error('pull number must be a positive integer');
  }
  return Number(normalized);
}

export function parsePullRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('pull request payload is required');
  return {
    repository: assertRepository(payload.repository),
    pullNumber: assertPullNumber(payload.pullNumber),
    baseOid: assertOid(payload.baseOid, 'base OID'),
    headOid: assertOid(payload.headOid, 'head OID'),
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

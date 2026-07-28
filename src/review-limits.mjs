export const MAX_PUBLIC_FAILURES = 512;
export const MAX_PUBLIC_FINDINGS = 128;
export const MAX_PUBLIC_SUGGESTIONS = 16;

export const PUBLIC_FINDING_TEXT_LIMITS = Object.freeze({
  taxonomy: 64,
  path: 500,
  title: 180,
  evidence: 6_000,
  rootCause: 2_000,
});

export const PUBLIC_FAILURE_TEXT_LIMITS = Object.freeze({
  stage: 300,
  error: 4_000,
  diagnostic: 4_000,
});

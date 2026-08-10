export const MAX_PUBLIC_FAILURES = 512;
export const MAX_PUBLIC_FINDINGS = 128;
export const MAX_PUBLIC_SUGGESTIONS = 16;
// Runaway guards, not policy. The failure budget already caps tolerated gaps at
// 8% of the finder batches, and the diff byte ceiling caps those batches: a
// 4 MiB diff is ~105 batches x 8 dimensions, so ~67 gaps at the very worst.
// The per-gap path cap is the same kind of backstop for one enormous batch.
export const MAX_PUBLIC_COVERAGE_GAPS = 128;
export const MAX_PUBLIC_COVERAGE_GAP_PATHS = 32;

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
  apiErrorMessage: 240,
});

export const PUBLIC_COVERAGE_GAP_TEXT_LIMITS = Object.freeze({
  stage: 300,
  path: 500,
  error: 1_000,
  diagnostic: 1_000,
  apiErrorMessage: 240,
});

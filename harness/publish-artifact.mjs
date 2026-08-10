// Turn the runner's v2r1 review into the three files the finalizer publishes.
//
// WHY A TRANSLATOR AND NOT ONE SCHEMA
//
// The runner's format is richer than the published one on purpose. v2r1 carries
// headOid, degradations[] and resumedFrom, and its finding.evidence is a MEASURED
// object - mode, the commands actually run, their exit codes, the artifacts they
// left, and the assignment that ran them. That is the whole point of v2: a
// finding is backed by something that was executed. None of it belongs in the
// published review.json, whose schema is a merge-gate contract that predates v2
// and is validated character-exactly by the finalize job.
//
// So this converts, and it converts LOSSLESSLY WHERE IT MATTERS: everything the
// published schema cannot carry is rendered into review.md, which is the file a
// human actually reads. Nothing measured is silently dropped.
//
// WHAT IS DELIBERATELY REUSED
//
// createManifest() is imported from src/artifact-manifest.mjs - the same builder
// v1 uses. A second implementation of the manifest would be a second thing to
// keep in step with the finalizer, and the finalizer is the merge gate. There is
// one builder.
//
// THE SIZE CAPS ARE MEASURED IN BYTES, BECAUSE THE ENFORCER MEASURES BYTES
//
// write-finalize accepts an artifact only if
//     wc -c < _review/review.md    <= 65536
//     wc -c < _review/review.json  <= 1048576
// and `wc -c` counts BYTES. This file used to cap both by CODE POINTS, which is
// the same number only for ASCII. It is not the same number here: this project's
// review policy and half its source comments are Chinese, so a non-ASCII verdict
// is the expected case. Measured on the fixtures in test-publish-artifact.mjs, a
// 20-finding Chinese verdict renders 25,623 code points of review.md - well
// under the cap, so no truncation fired - and 68,343 bytes, which the gate
// rejects. review.json fails in pure ASCII too: 128 findings x (6000-code-point
// evidence + 2000 rootCause + 180 title + 500 path) is a review the runner's own
// validator accepts, and this file serialised it to 1,132,849 bytes.
//
// The failure that produced is the worst one available. The artifact uploads, so
// the DOWNLOAD in write-finalize succeeds, so the missing-artifact handoff that
// exists to guarantee a comment does not fire; the size check then kills the
// job. Red X on the pull request and no comment at all - the single outcome the
// write job exists to make impossible.
//
// Per-FIELD limits stay in code points, and that is not an oversight left
// behind: the gate's jq is what measures them (`.evidence | length <= 6000`) and
// jq's `length` on a string counts code points - `jq -n '"emoji" | length'` is 1
// for an astral character. Byte-capping a field here would reject reviews the
// gate accepts. Bytes are a property of the whole FILE, so they are bounded at
// the file, in fitPublishedReview and renderMarkdown.
//
// Usage:
//   node harness/publish-artifact.mjs <runner-review.json> <out-dir>
// Environment: REPOSITORY PULL_NUMBER BASE_OID HEAD_OID RUN_ID RUN_ATTEMPT
//              WORKFLOW_REF POLICY_SHA256
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createManifest } from '../src/artifact-manifest.mjs';
import { validateRunnerReview } from './validate-review.mjs';

const MAX_EVIDENCE = 6000;
export const MAX_MD_BYTES = 65536;
export const MAX_JSON_BYTES = 1048576;
// Floor for the per-finding evidence budget when the whole file has to shrink.
// Big enough to keep the `mode=/assignment=/exit=` head plus the start of the
// first command, so a clipped finding still says what ran it.
const MIN_EVIDENCE_BYTES = 200;

const EVIDENCE_FIELD_NOTICE = '\n[truncated for the 6000-character evidence limit]';
const EVIDENCE_BUDGET_NOTICE = `\n[clipped to fit the ${MAX_JSON_BYTES}-byte review.json limit]`;
const MD_NOTICE = `\n\n[truncated for the ${MAX_MD_BYTES}-byte review.md limit]`;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`publish-artifact: ${name} is required`);
  return value;
}

// Cut to a byte budget without splitting a character. Encoding to UTF-8 FIRST is
// what makes that true for astral characters as well: a surrogate pair is a
// single four-byte sequence in UTF-8, so backing off to a lead byte steps over
// the whole sequence and cannot leave half an emoji - or a lone surrogate, which
// JSON.stringify would then emit as an unpaired \udXXX escape - behind. Slicing
// the JS string by .length or by code points cannot express a byte budget at all.
function clipToBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  const limit = Math.max(0, maxBytes);
  if (buffer.length <= limit) return text;
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.toString('utf8', 0, end);
}

// The one place that knows both units. Callers pass whichever bounds are real
// for their field, and the notice is appended INSIDE the budget - a truncation
// marker that pushes the value back over the cap has truncated nothing. The
// code-point bound is applied to the head as well as the byte bound, because
// appending a 51-character notice to a value already at 6000 code points is how
// a "fix" for the byte cap breaks the gate's per-field code-point check.
function bounded(text, { maxCodePoints = Infinity, maxBytes = Infinity, notice }) {
  const codePoints = maxCodePoints === Infinity ? null : [...text];
  if ((codePoints === null || codePoints.length <= maxCodePoints)
    && Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const head = codePoints === null
    ? text
    : codePoints.slice(0, Math.max(0, maxCodePoints - [...notice].length)).join('');
  return `${clipToBytes(head, maxBytes - Buffer.byteLength(notice, 'utf8'))}${notice}`;
}

function commandsToText(commands) {
  return commands.map((command) => `$ ${command}`).join('\n');
}

// The measured evidence object, flattened into the string the published schema
// takes. Deterministic field order so the same review always hashes the same -
// the manifest binds these hashes, and a hash that moves for no reason turns
// into "artifacts do not match manifest" at the gate.
//
// maxBytes is this finding's share of the whole-file review.json budget; see
// fitPublishedReview. Default Infinity means "the field cap is the only cap",
// which is the case for every review that fits without help.
function evidenceToText(evidence, maxBytes = Infinity) {
  const head = `mode=${evidence.mode} assignment=${evidence.assignmentId} exit=${evidence.exitCodes.join(',')}`;
  const artifacts = evidence.artifacts.length ? `\nartifacts: ${evidence.artifacts.join(', ')}` : '';
  const text = `${head}\n${commandsToText(evidence.commands)}${artifacts}`;
  // Truncate at the END and say so. A silently clipped command line reads as a
  // command that was run differently from the one that was run. The two notices
  // are distinct because the two reasons are: one is this field being too long,
  // the other is the file it lives in being too big.
  const field = bounded(text, { maxCodePoints: MAX_EVIDENCE, notice: EVIDENCE_FIELD_NOTICE });
  return bounded(field, { maxCodePoints: MAX_EVIDENCE, maxBytes, notice: EVIDENCE_BUDGET_NOTICE });
}

export function toPublishedReview(runner, {
  findings = runner.findings,
  failures = runner.failures,
  evidenceBytes = Infinity,
} = {}) {
  return {
    version: 'v2',
    decision: runner.decision,
    findings: findings.map((finding) => ({
      taxonomy: finding.taxonomy,
      path: finding.path,
      line: finding.line,
      title: finding.title,
      evidence: evidenceToText(finding.evidence, evidenceBytes),
      rootCause: finding.rootCause,
      level: finding.level,
      fingerprint: finding.fingerprint,
    })),
    // v2r1 has no suggestion channel: the crew produces evidence and sol judges,
    // and neither is asked for optional advice. Empty and zero are the honest
    // values, not a placeholder - and omittedSuggestions is a COUNT, not a list.
    suggestions: [],
    omittedSuggestions: 0,
    failures,
  };
}

// Exactly the bytes that land on disk, trailing newline included - `wc -c`
// counts that newline, so budgeting the string without it is off by one at the
// only boundary that matters.
function serializeReview(review) {
  return `${JSON.stringify(review, null, 2)}\n`;
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

// Largest n in [lo, hi] with fits(n), or null when even fits(lo) is false.
// Every knob fitPublishedReview turns is monotone - a smaller evidence budget
// clips at least as much from every field, and a shorter list serialises to at
// most as many bytes - so this search is exact rather than a heuristic, and it
// costs ~log2(range) serialisations instead of the hundreds a linear walk over
// 128 findings or 512 failures would.
function largestThatFits(lo, hi, fits) {
  if (!fits(lo)) return null;
  let best = lo;
  let low = lo;
  let high = hi;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  return best;
}

// Produce the review.json TEXT, guaranteed to fit MAX_JSON_BYTES, and say what
// that cost. validateRunnerReview does not make the fit true: its per-field
// caps multiply out to more than a megabyte (128 findings x 8180 code points of
// title+rootCause+evidence, before JSON structure), which is not a theoretical
// bound - the ASCII fixture in test-publish-artifact.mjs measures 1,132,849
// bytes at head.
//
// Shrink in the order that loses the least, and never below what the gate's
// decision invariants require, because a review.json the jq program rejects is
// the same red-X-with-no-comment by a different route:
//
//   1. evidence. Derived text, already truncatable by contract, and the only
//      field big enough to matter. Clipping it keeps every finding's path, line,
//      title, rootCause, level and fingerprint - all of the merge-gate content.
//   2. whole findings/failures from the tail, floored at one finding for
//      request_changes and one failure for infrastructure_failure.
//
// What was lost is reported to the caller so renderMarkdown can SAY it on the
// pull request. A silent drop would leave a verdict that looks complete and is
// not, which is worse than the oversize file this replaces.
export function fitPublishedReview(runner, maxBytes = MAX_JSON_BYTES) {
  const build = (findings, failures, evidenceBytes) =>
    serializeReview(toPublishedReview(runner, { findings, failures, evidenceBytes }));
  const none = { findings: 0, failures: 0, evidenceBytes: null };

  const whole = build(runner.findings, runner.failures, Infinity);
  if (byteLength(whole) <= maxBytes) return { text: whole, dropped: none };

  // Seed the search at the WIDEST evidence field actually present, not at the
  // 24000-byte ceiling of a 6000-code-point string: a budget above every real
  // field clips nothing, so a search seeded there wastes its whole upper half.
  const widest = runner.findings.reduce(
    (most, finding) => Math.max(most, byteLength(evidenceToText(finding.evidence))), 0);
  const budget = largestThatFits(MIN_EVIDENCE_BYTES, widest,
    (n) => byteLength(build(runner.findings, runner.failures, n)) <= maxBytes);
  if (budget !== null) {
    return {
      text: build(runner.findings, runner.failures, budget),
      dropped: { ...none, evidenceBytes: budget },
    };
  }

  // The decision invariants make rung 2 one-dimensional: approve and
  // request_changes carry zero failures, infrastructure_failure carries zero
  // findings, and main() has already run validateRunnerReview, so only one of
  // these two lists can be non-empty. Both are searched anyway - the cost is one
  // failed fits() call and the alternative is a correctness claim that depends
  // on a validator three files away staying exactly as it is.
  const minFindings = runner.decision === 'request_changes' ? 1 : 0;
  const minFailures = runner.decision === 'infrastructure_failure' ? 1 : 0;

  const keptFindings = largestThatFits(minFindings, runner.findings.length,
    (n) => byteLength(build(runner.findings.slice(0, n), runner.failures, MIN_EVIDENCE_BYTES)) <= maxBytes);
  if (keptFindings !== null) {
    return {
      text: build(runner.findings.slice(0, keptFindings), runner.failures, MIN_EVIDENCE_BYTES),
      dropped: {
        findings: runner.findings.length - keptFindings,
        failures: 0,
        evidenceBytes: MIN_EVIDENCE_BYTES,
      },
    };
  }

  const findings = runner.findings.slice(0, minFindings);
  const keptFailures = largestThatFits(minFailures, runner.failures.length,
    (n) => byteLength(build(findings, runner.failures.slice(0, n), MIN_EVIDENCE_BYTES)) <= maxBytes);
  if (keptFailures !== null) {
    return {
      text: build(findings, runner.failures.slice(0, keptFailures), MIN_EVIDENCE_BYTES),
      dropped: {
        findings: runner.findings.length - findings.length,
        failures: runner.failures.length - keptFailures,
        evidenceBytes: MIN_EVIDENCE_BYTES,
      },
    };
  }

  // Not reachable with any review validateRunnerReview accepts: the floor is one
  // finding or one failure, whose fields cap at 500+180+2000 or 300+4000+4000
  // code points - under 30 KB even if every one of them is four bytes wide. It
  // is a throw rather than an assertion because throwing is SAFE here: no
  // artifact is written, write-finalize's download fails, and the
  // missing-artifact handoff posts an infrastructure_failure comment. That is a
  // degraded outcome, not the forbidden one.
  throw new Error(`publish-artifact: review.json does not fit ${maxBytes} bytes even at its smallest publishable shape`);
}

// The lines that tell a human what the byte budget cost them. Empty when the
// review fit as produced, which is every review that is not pathological.
function reductionNotice(runner, dropped) {
  const parts = [];
  if (dropped.findings) parts.push(`${dropped.findings} finding(s) dropped from the end`);
  if (dropped.failures) parts.push(`${dropped.failures} failure(s) dropped from the end`);
  // Only when there are findings left to have had evidence clipped: an
  // infrastructure_failure carries none, and "evidence clipped per finding" over
  // zero findings is a sentence that describes nothing.
  if (dropped.evidenceBytes !== null && runner.findings.length - dropped.findings > 0) {
    parts.push(`evidence clipped to ${dropped.evidenceBytes} bytes per finding`);
  }
  if (!parts.length) return [];
  return [
    `> **\`review.json\` was reduced to fit the ${MAX_JSON_BYTES}-byte publish limit:** ${parts.join('; ')}.`,
    '> What follows in this comment is the unreduced verdict, up to this comment\'s own limit.',
    '',
  ];
}

function fence(text) {
  return `\`\`\`\n${String(text).replace(/```/g, "'''")}\n\`\`\``;
}

export function renderMarkdown(runner, { repository, pullNumber, runId, dropped }) {
  const lines = [];
  lines.push('## Central review (v2)');
  lines.push('');
  lines.push(`**Decision:** \`${runner.decision}\``);
  lines.push('');
  lines.push(`Reviewed head \`${runner.headOid}\` of ${repository}#${pullNumber}, run ${runId}.`);
  lines.push('');
  // ABOVE the findings, not at the end. review.md is itself cut from the TAIL to
  // fit its byte cap, so a notice at the bottom is the first thing that cut
  // removes - and this notice exists precisely for the reviews big enough for
  // that cut to happen. It is also the only published place the drop can be
  // recorded: the gate's jq pins review.json's key set to exactly six names, so
  // there is no field there to put it in and no honest way to overload
  // omittedSuggestions, which counts suggestions.
  if (dropped) lines.push(...reductionNotice(runner, dropped));

  if (runner.findings.length) {
    lines.push(`### Findings (${runner.findings.length})`);
    lines.push('');
    for (const finding of runner.findings) {
      lines.push(`#### \`${finding.level}\` ${finding.title}`);
      lines.push('');
      lines.push(`- \`${finding.path}:${finding.line}\` — ${finding.taxonomy}`);
      lines.push(`- **Root cause:** ${finding.rootCause}`);
      lines.push(`- **Evidence** (${finding.evidence.mode}, assignment ${finding.evidence.assignmentId}, exit ${finding.evidence.exitCodes.join(',')}):`);
      // Bounded by the same MAX_EVIDENCE the published review.json field gets,
      // through the same helper. Rendered raw this block is 64 commands x 2000
      // characters = 128,000 characters for ONE finding, which is twice the
      // whole review.md budget: a single chatty finding pushed every finding
      // after it past the truncation point. Measured on the 128-finding ASCII
      // fixture, review.md filled 65,531 bytes carrying 8 of its 128 findings.
      // Not evidenceToText() itself only because mode, assignment, exit codes
      // and artifacts are already their own bullets here.
      lines.push(fence(bounded(commandsToText(finding.evidence.commands), {
        maxCodePoints: MAX_EVIDENCE,
        notice: EVIDENCE_FIELD_NOTICE,
      })));
      if (finding.evidence.artifacts.length) {
        lines.push(`- Artifacts: ${finding.evidence.artifacts.map((a) => `\`${a}\``).join(', ')}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No findings.');
    lines.push('');
  }

  if (runner.failures.length) {
    lines.push(`### Failures (${runner.failures.length})`);
    lines.push('');
    for (const failure of runner.failures) {
      lines.push(`- \`${failure.status}\` at **${failure.stage}**: ${failure.error}`);
      if (failure.diagnostic) lines.push(`  - ${failure.diagnostic}`);
    }
    lines.push('');
  }

  // The two fields the published schema cannot carry. They go here or nowhere,
  // and "nowhere" would mean a review that quietly ran in a degraded mode looks
  // identical to one that did not.
  if (runner.degradations?.length) {
    lines.push(`### Degradations (${runner.degradations.length})`);
    lines.push('');
    lines.push('This review did not run in its intended mode throughout:');
    lines.push('');
    for (const degradation of runner.degradations) {
      lines.push(`- \`${degradation.at}\` ${degradation.from} → ${degradation.to}: ${degradation.reason}`);
    }
    lines.push('');
  }
  if (runner.resumedFrom) {
    lines.push(`Resumed from checkpoint \`${runner.resumedFrom}\`.`);
    lines.push('');
  }

  // main() writes `${text}\n`, and `wc -c` counts that newline, so the string
  // gets one byte less than the cap.
  return bounded(lines.join('\n'), { maxBytes: MAX_MD_BYTES - 1, notice: MD_NOTICE });
}

export async function main(argv) {
  const [source, outDir] = argv;
  if (!source || !outDir) throw new Error('usage: publish-artifact.mjs <runner-review.json> <out-dir>');

  const runner = JSON.parse(await readFile(source, 'utf8'));
  // Refuse to publish something the runner's own validator rejects. The finalize
  // job would refuse it too, but four steps later and as "invalid final review
  // schema", which names the wrong file.
  const verdict = validateRunnerReview(runner);
  if (!verdict.ok) {
    throw new Error(`publish-artifact: runner review is not valid v2r1: ${verdict.errors.join('; ')}`);
  }

  const repository = need('REPOSITORY');
  const pullNumber = Number(need('PULL_NUMBER'));
  const headOid = need('HEAD_OID');
  if (runner.headOid !== headOid) {
    // The gate's whole promise is that the verdict names the commit it judged.
    throw new Error(`publish-artifact: runner reviewed ${runner.headOid} but the PR head is ${headOid}`);
  }

  const { text: reviewJson, dropped } = fitPublishedReview(runner);
  const markdown = renderMarkdown(runner, { repository, pullNumber, runId: need('RUN_ID'), dropped });
  const artifacts = {
    'review.json': reviewJson,
    'review.md': `${markdown}\n`,
  };
  const manifest = createManifest({
    context: { repository, pullNumber, baseOid: need('BASE_OID'), headOid },
    runId: need('RUN_ID'),
    runAttempt: need('RUN_ATTEMPT'),
    workflowRef: need('WORKFLOW_REF'),
    reviewOid: headOid,
    policySha256: need('POLICY_SHA256'),
    artifacts,
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/review.json`, artifacts['review.json']);
  await writeFile(`${outDir}/review.md`, artifacts['review.md']);
  await writeFile(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    decision: runner.decision,
    findings: runner.findings.length - dropped.findings,
    dropped,
  };
}

// The drop is on stdout as well as in review.md, but review.md is the one that
// counts: a job log is not where anybody looks for what a verdict left out.
function reductionSuffix({ findings, failures, evidenceBytes }) {
  if (!findings && !failures && evidenceBytes === null) return '';
  return ` reduced=findings-dropped:${findings},failures-dropped:${failures},evidence-bytes:${evidenceBytes}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`publish-artifact: decision=${result.decision} findings=${result.findings}${reductionSuffix(result.dropped)}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exit(65); },
  );
}

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
// Usage:
//   node harness/publish-artifact.mjs <runner-review.json> <out-dir>
// Environment: REPOSITORY PULL_NUMBER BASE_OID HEAD_OID RUN_ID RUN_ATTEMPT
//              WORKFLOW_REF POLICY_SHA256
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createManifest } from '../src/artifact-manifest.mjs';
import { validateRunnerReview } from './validate-review.mjs';

const MAX_EVIDENCE = 6000;
const MAX_MD = 65536;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`publish-artifact: ${name} is required`);
  return value;
}

// The measured evidence object, flattened into the string the published schema
// takes. Deterministic field order so the same review always hashes the same -
// the manifest binds these hashes, and a hash that moves for no reason turns
// into "artifacts do not match manifest" at the gate.
function evidenceToText(evidence) {
  const head = `mode=${evidence.mode} assignment=${evidence.assignmentId} exit=${evidence.exitCodes.join(',')}`;
  const commands = evidence.commands.map((command) => `$ ${command}`).join('\n');
  const artifacts = evidence.artifacts.length ? `\nartifacts: ${evidence.artifacts.join(', ')}` : '';
  const text = `${head}\n${commands}${artifacts}`;
  if ([...text].length <= MAX_EVIDENCE) return text;
  // Truncate at the END and say so. A silently clipped command line reads as a
  // command that was run differently from the one that was run.
  return `${[...text].slice(0, MAX_EVIDENCE - 40).join('')}\n[truncated for the 6000-char limit]`;
}

export function toPublishedReview(runner) {
  return {
    version: 'v2',
    decision: runner.decision,
    findings: runner.findings.map((finding) => ({
      taxonomy: finding.taxonomy,
      path: finding.path,
      line: finding.line,
      title: finding.title,
      evidence: evidenceToText(finding.evidence),
      rootCause: finding.rootCause,
      level: finding.level,
      fingerprint: finding.fingerprint,
    })),
    // v2r1 has no suggestion channel: the crew produces evidence and sol judges,
    // and neither is asked for optional advice. Empty and zero are the honest
    // values, not a placeholder - and omittedSuggestions is a COUNT, not a list.
    suggestions: [],
    omittedSuggestions: 0,
    failures: runner.failures,
  };
}

function fence(text) {
  return `\`\`\`\n${String(text).replace(/```/g, "'''")}\n\`\`\``;
}

export function renderMarkdown(runner, { repository, pullNumber, runId }) {
  const lines = [];
  lines.push('## Central review (v2)');
  lines.push('');
  lines.push(`**Decision:** \`${runner.decision}\``);
  lines.push('');
  lines.push(`Reviewed head \`${runner.headOid}\` of ${repository}#${pullNumber}, run ${runId}.`);
  lines.push('');

  if (runner.findings.length) {
    lines.push(`### Findings (${runner.findings.length})`);
    lines.push('');
    for (const finding of runner.findings) {
      lines.push(`#### \`${finding.level}\` ${finding.title}`);
      lines.push('');
      lines.push(`- \`${finding.path}:${finding.line}\` — ${finding.taxonomy}`);
      lines.push(`- **Root cause:** ${finding.rootCause}`);
      lines.push(`- **Evidence** (${finding.evidence.mode}, assignment ${finding.evidence.assignmentId}, exit ${finding.evidence.exitCodes.join(',')}):`);
      lines.push(fence(finding.evidence.commands.map((command) => `$ ${command}`).join('\n')));
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

  const text = lines.join('\n');
  if ([...text].length <= MAX_MD) return text;
  return `${[...text].slice(0, MAX_MD - 60).join('')}\n\n[truncated for the 65536-char limit]`;
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

  const published = toPublishedReview(runner);
  const markdown = renderMarkdown(runner, { repository, pullNumber, runId: need('RUN_ID') });
  const artifacts = {
    'review.json': `${JSON.stringify(published, null, 2)}\n`,
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
  return { decision: published.decision, findings: published.findings.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (result) => process.stdout.write(`publish-artifact: decision=${result.decision} findings=${result.findings}\n`),
    (error) => { process.stderr.write(`${error.message}\n`); process.exit(65); },
  );
}

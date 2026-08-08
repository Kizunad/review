// Deterministic fake worker for local/CI smoke tests. Replaces a real pi pane:
// it watches $HARNESS_DIR/directives/W<N>.md for a new directive from the
// trunk, extracts the assignment id, and writes a VALID evidence file at
// $HARNESS_DIR/evidence/<id>.json per the v2-evidence.1 contract. No model
// involved - the point is to exercise the orchestration loop (boot -> dispatch
// -> evidence -> checkpoint -> wrapper -> review.json) deterministically.
//
// Usage: node fake/worker.mjs W1    (env HARNESS_DIR, HEAD_OID required)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const worker = process.argv[2];
if (!/^W[12]$/.test(worker ?? '')) {
  throw new Error('usage: fake/worker.mjs W1|W2');
}
const harnessDir = process.env.HARNESS_DIR;
const headOid = process.env.HEAD_OID;
if (!harnessDir || !/^[0-9a-f]{40}$/.test(String(headOid ?? ''))) {
  throw new Error('fake worker needs HARNESS_DIR and a 40-hex HEAD_OID');
}

const directiveFile = path.join(harnessDir, 'directives', `${worker}.md`);
const evidenceDir = path.join(harnessDir, 'evidence');
const ASSIGNMENT = /s-[0-9]+/;

let seen = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeEvidence(assignmentId) {
  const file = path.join(evidenceDir, `${assignmentId}.json`);
  const evidence = {
    version: 'v2-evidence.1',
    assignmentId,
    mode: 'test',
    worker,
    headOid,
    commands: [`node fake/worker.mjs ${worker} (fake)`],
    artifacts: [],
    exitCodes: [0],
    verdict: 'pass',
    notes: 'deterministic fake evidence from the smoke worker',
    binaryProvenance: null,
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${worker}: evidence written for ${assignmentId}`);
}

while (true) {
  const current = existsSync(directiveFile) ? readFileSync(directiveFile, 'utf8') : '';
  if (current !== seen) {
    seen = current;
    const match = ASSIGNMENT.exec(current);
    if (match) {
      const id = match[0];
      if (!existsSync(path.join(evidenceDir, `${id}.json`))) {
        await writeEvidence(id);
      }
    }
  }
  await sleep(2000);
}

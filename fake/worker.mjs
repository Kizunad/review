// Deterministic fake worker for local/CI smoke tests. Replaces a real pi pane
// and speaks BOTH worker channels:
//
//   1. stdin (the tmux pane channel): v2/dispatch.sh types the directive into
//      the pane and verifies delivery by watching for pi's busy signal. The
//      fake worker honors that contract - on receiving a directive line it
//      prints 'Working...' immediately (so dispatch acceptance sees a busy
//      pane), simulates work for FAKE_WORKER_DELAY_MS, writes the evidence,
//      then CLEARS the screen (like a TUI status line vanishing) so the pane
//      reads idle again and stale 'Working...' text cannot fool the next
//      busy-check.
//   2. directives/W<N>.md (the crash-recovery record dispatch.sh writes):
//      polled as a fallback so a directive that raced past stdin still lands.
//
// No model involved - the point is to exercise the orchestration loop
// (boot -> dispatch -> evidence -> checkpoint -> wrapper -> review.json)
// deterministically, through the SAME pane plumbing the real pi worker uses.
//
// Usage: node fake/worker.mjs W1    (env HARNESS_DIR, HEAD_OID required;
//        FAKE_WORKER_DELAY_MS simulated work time, default 6000)
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const worker = process.argv[2];
if (!/^W[12]$/.test(worker ?? '')) {
  throw new Error('usage: fake/worker.mjs W1|W2');
}
const harnessDir = process.env.HARNESS_DIR;
const headOid = process.env.HEAD_OID;
if (!harnessDir || !/^[0-9a-f]{40}$/.test(String(headOid ?? ''))) {
  throw new Error('fake worker needs HARNESS_DIR and a 40-hex HEAD_OID');
}
const delayMs = Number(process.env.FAKE_WORKER_DELAY_MS ?? 6000);

const directiveFile = path.join(harnessDir, 'directives', `${worker}.md`);
const evidenceDir = path.join(harnessDir, 'evidence');
const ASSIGNMENT = /s-[0-9]+/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

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
}

let working = false;
async function handleAssignment(assignmentId) {
  if (existsSync(path.join(evidenceDir, `${assignmentId}.json`))) return;
  if (working) return;
  working = true;
  // Busy signal FIRST: dispatch.sh polls the pane for exactly this string.
  console.log('Working...');
  await sleep(delayMs);
  await writeEvidence(assignmentId);
  clearScreen();
  console.log(`DONE ${assignmentId}`);
  console.log(`READY ${worker}`);
  working = false;
}

// Channel 1: pane input via stdin lines (what dispatch.sh actually delivers).
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const match = ASSIGNMENT.exec(line);
  if (match) void handleAssignment(match[0]);
});

// Channel 2: the directive file dispatch.sh writes (crash-recovery record).
let seen = '';
console.log(`READY ${worker}`);
while (true) {
  const current = existsSync(directiveFile) ? readFileSync(directiveFile, 'utf8') : '';
  if (current !== seen) {
    seen = current;
    const match = ASSIGNMENT.exec(current);
    if (match) await handleAssignment(match[0]);
  }
  await sleep(2000);
}

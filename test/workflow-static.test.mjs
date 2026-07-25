import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../.github/workflows/review.yml', import.meta.url);
const setupClaudePath = new URL('../.github/actions/setup-claude/action.yml', import.meta.url);

const consumerContractPath = new URL('../docs/consumer-contract.md', import.meta.url);

async function workflow() {
  return readFile(workflowPath, 'utf8');
}

async function consumerContract() {
  return readFile(consumerContractPath, 'utf8');
}

async function setupClaude() {
  return readFile(setupClaudePath, 'utf8');
}

test('workflow derives central checkout identity from the immutable run reference', async () => {
  const yaml = await workflow();
  assert.match(yaml, /actions: read/);
  assert.match(yaml, /actions\/runs\/\$GITHUB_RUN_ID\/attempts\/\$GITHUB_RUN_ATTEMPT/);
  assert.match(yaml, /\.referenced_workflows\[\]\?/);
  assert.match(yaml, /Kizunad\/review\/\.github\/workflows\/review\.yml@/);
  assert.match(yaml, /expected exactly one central review workflow reference/);
  assert.match(yaml, /select\(\.path == \(\"Kizunad\/review\/\.github\/workflows\/review\.yml@\" \+ \.sha\)\)/);
  assert.match(yaml, /select\(test\(\"\^\[0-9a-f\]\{40\}\$\"\)\)/);
  assert.match(yaml, /remote add origin https:\/\/github\.com\/Kizunad\/review\.git/);
  assert.match(yaml, /repository: Kizunad\/review/);
  assert.doesNotMatch(yaml, /job\.workflow_ref|github\.workflow_ref|github\.action_(?:repository|ref)/);
});

test('consumer grants the reusable workflow actions metadata permission', async () => {
  const contract = await consumerContract();
  assert.match(contract, /permissions:\n\s+actions: read\n\s+contents: read\n\s+pull-requests: write\n\s+issues: write/);
});

test('workflow obtains base history and never runs caller scripts', async () => {
  const yaml = await workflow();
  const callerCheckout = /Checkout exact caller head into isolated directory[\s\S]*?fetch-depth: 0/.test(yaml);
  assert.equal(callerCheckout, true, 'caller checkout must fetch base history before diffing API base OID');
  assert.match(yaml, /git -C _caller[^\n]*diff[^\n]*"\$BASE_OID" "\$HEAD_OID"/);
  assert.doesNotMatch(yaml, /(?:npm|yarn|pnpm|bash|sh)\s+(?:_caller|\.\/_caller|_caller\/)/);
});

test('workflow wires hash-pinned Claude Code and ripgrep binaries to the deterministic read-only runner', async () => {
  const yaml = await workflow();
  const action = await setupClaude();
  assert.match(yaml, /uses: \.\/_central\/\.github\/actions\/setup-claude/);
  assert.match(action, /claude-code-linux-x64-2\.1\.220\.tgz/);
  assert.match(action, /25d2e2cae6d3d1d5ceeaf0da02e83c45c16455e45efa1ab305395dc05227ad0d/);
  assert.match(action, /ripgrep-14\.1\.1-x86_64-unknown-linux-musl\.tar\.gz/);
  assert.match(action, /4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e/);
  assert.match(action, /sha256sum --check --strict/);
  assert.match(action, /--strip-components=1/);
  assert.match(action, /--no-same-owner --no-same-permissions package\/claude/);
  assert.match(action, /ripgrep-14\.1\.1-x86_64-unknown-linux-musl\/rg/);
  assert.match(action, /Pinned Claude Code executable is not ELF/);
  assert.match(action, /Pinned ripgrep executable is not a regular file/);
  assert.match(action, /ripgrep 14\.1\.1 \(rev 4649aa9700\)/);
  assert.doesNotMatch(action, /npm (?:install|view)|--ignore-scripts/);
  assert.match(yaml, /node _central\/src\/run-review\.mjs/);
  assert.match(yaml, /ANTHROPIC_API_KEY: \$\{\{ secrets\.review_api_key \}\}/);
  assert.match(yaml, /ANTHROPIC_BASE_URL: \$\{\{ inputs\.review_base_url \}\}/);
  assert.match(yaml, /POLICY_FILE: \$\{\{ github\.workspace \}\}\/_trusted\/policy\.json/);
  assert.match(yaml, /CLAUDE_EXECUTABLE: \$\{\{ env\.CLAUDE_EXECUTABLE \}\}/);
  assert.match(yaml, /RIPGREP_EXECUTABLE: \$\{\{ env\.RIPGREP_EXECUTABLE \}\}/);
  assert.match(yaml, /BWRAP_EXECUTABLE: \$\{\{ env\.BWRAP_EXECUTABLE \}\}/);
  assert.match(yaml, /POLICY_SHA256=.*assertRegularFileInsideWorkspace/s);
  assert.match(yaml, /runAttempt: process\.env\.EXPECTED_RUN_ATTEMPT/);
  assert.match(yaml, /policySha256: process\.env\.POLICY_SHA256/);
  assert.doesNotMatch(yaml, /secrets:\s*inherit/);
});

test('workflow installs hash-pinned Bubblewrap and exports absolute sandbox executables', async () => {
  const yaml = await workflow();
  assert.match(yaml, /bubblewrap_0\.9\.0-1ubuntu0\.1_amd64\.deb/);
  assert.match(yaml, /1b506492bd9c7fd0cdb4f02ac822f1d3e336b0aead5113c1239baf8db5db562a/);
  assert.match(yaml, /sha256sum --check --strict/);
  assert.match(yaml, /sudo chown root:root "\$bwrap_executable"/);
  assert.match(yaml, /sudo chmod 4755 "\$bwrap_executable"/);
  assert.match(yaml, /root:root 4755/);
  assert.match(await setupClaude(), /CLAUDE_EXECUTABLE=%s/);
  assert.match(await setupClaude(), /RIPGREP_EXECUTABLE=%s/);
  assert.match(yaml, /BWRAP_EXECUTABLE=%s/);
  assert.match(yaml, /--unshare-all --share-net --die-with-parent --new-session/);
});

test('workflow separates read-only control and review jobs from the only write-capable finalizer', async () => {
  const yaml = await workflow();
  const preflight = yaml.match(/\n  preflight:\n([\s\S]*?)\n  review:\n/)?.[1] ?? '';
  const review = yaml.match(/\n  review:\n([\s\S]*?)\n  finalize:\n/)?.[1] ?? '';
  const finalize = yaml.match(/\n  finalize:\n([\s\S]*)$/)?.[1] ?? '';
  assert.match(preflight, /actions: read/);
  assert.match(preflight, /contents: read/);
  assert.match(preflight, /pull-requests: read/);
  assert.match(preflight, /issues: read/);
  assert.doesNotMatch(preflight, /pull-requests: write|issues: write/);
  assert.match(review, /contents: read/);
  assert.match(review, /pull-requests: read/);
  assert.doesNotMatch(review, /pull-requests: write|issues: write/);
  assert.match(finalize, /pull-requests: write/);
  assert.match(finalize, /issues: write/);
  assert.doesNotMatch(finalize, /ANTHROPIC_API_KEY|review_api_key/);
});
test('workflow uses an untrusted checkout only to build a sanitized Claude review snapshot', async () => {
  const yaml = await workflow();
  assert.match(yaml, /CALLER_ROOT: \$\{\{ github\.workspace \}\}\/_caller/);
  assert.match(yaml, /node _central\/src\/run-review\.mjs/);
  assert.doesNotMatch(yaml, /cwd:\s*_caller|claude\s+.*_caller/);
});

test('workflow keeps a caller-owned fail-open circuit around automatic infrastructure failures', async () => {
  const yaml = await workflow();
  const preflight = yaml.match(/\n  preflight:\n([\s\S]*?)\n  review:\n/)?.[1] ?? '';
  const finalize = yaml.match(/\n  finalize:\n([\s\S]*)$/)?.[1] ?? '';
  const record = finalize.match(/Record infrastructure failure in caller circuit([\s\S]*?)\n      - name: Preserve validated review outcome/)?.[1] ?? '';
  assert.match(preflight, /node _central\/src\/run-circuit\.mjs preflight/);
  assert.match(preflight, /circuit_should_run: \$\{\{ steps\.circuit\.outputs\.should_run \}\}/);
  assert.doesNotMatch(preflight, /skip-comment|postPullRequestComment/);
  assert.match(yaml, /if: needs\.preflight\.outputs\.circuit_should_run == 'true'/);
  assert.match(finalize, /node _central\/src\/run-circuit\.mjs skip-comment/);
  assert.match(record, /node _central\/src\/run-circuit\.mjs record/);
  assert.match(record, /steps\.publish\.outputs\.decision == 'infrastructure_failure'/);
  assert.doesNotMatch(record, /request_changes/);
  assert.match(finalize, /Preserve circuit skip as a non-verdict failure[\s\S]*?circuit_should_run == 'false'/);
  assert.match(finalize, /steps\.download\.outcome != 'success'/);
  assert.match(finalize, /steps\.publish\.outputs\.decision == 'request_changes' && inputs\.shadow != true/);
  assert.match(yaml, /REVIEW_COMMENT_BODY: \$\{\{ github\.event\.comment\.body \|\| '' \}\}/);
});

test('every referenced action is pinned to a full commit SHA', async () => {
  const yaml = await workflow();
  const uses = [...yaml.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)\s*$/gm)];
  assert.ok(uses.length > 0, 'workflow must reference pinned actions');
  for (const [, ref] of uses) assert.match(ref, /^[0-9a-f]{40}$/i, `action ref is not immutable: ${ref}`);
});

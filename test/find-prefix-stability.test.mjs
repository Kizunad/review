import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { stagePrompt } from '../src/claude-runner.mjs';

// The find stage fans out one call per taxonomy dimension (eight lenses per diff
// batch). The taxonomy VALUE is the only thing that differs between lenses -
// diff, summaries, policy, and every instruction are byte-identical. A prompt
// cache breakpoint can only share the prefix that precedes the first variable
// block, so the variable taxonomy must sit LAST: any other position silently
// shrinks the shareable prefix to the instruction block alone. This guards the
// order so a future reorder cannot reintroduce the trap.
test('find prompt: the taxonomy value is the final block, so lenses share a maximal stable prefix', () => {
  const centralRoot = process.cwd();
  const context = {
    policy: {},
    repository: 'org/repo',
    skillPath: path.join(centralRoot, '.claude/skills/code-review/SKILL.md'),
    skill: '',
  };
  const shared = { stage: 'find', summaries: [], paths: [], diff: 'diff text' };
  const prompts = ['security', 'correctness'].map((dimension) =>
    stagePrompt({ ...shared, taxonomy: { id: dimension } }, context),
  );

  for (const prompt of prompts) {
    const blocks = prompt.split('\n\n');
    const lastBlock = blocks[blocks.length - 1];
    assert.ok(
      lastBlock.startsWith('Assigned taxonomy dimension:'),
      'the taxonomy value must be the final block of the find prompt so the diff/summaries/policy stay in the stable prefix',
    );
    assert.ok(
      prompt.indexOf('Immutable pull-request diff batch:') < prompt.indexOf('Assigned taxonomy dimension:'),
      'the diff must precede the taxonomy value so the diff is inside the cross-lens stable prefix',
    );
  }

  const stablePrefix = (prompt) => {
    const blocks = prompt.split('\n\n');
    return blocks.slice(0, -1).join('\n\n');
  };
  assert.equal(
    stablePrefix(prompts[0]),
    stablePrefix(prompts[1]),
    "everything before the taxonomy value must be byte-identical across the batch's lenses",
  );
});

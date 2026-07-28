import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function read(relative) {
  return readFile(new URL(relative, root), 'utf8');
}

function visibleMarkdownLines(markdown) {
  const visibleLines = [];
  let fenceCharacter;
  let fenceLength = 0;
  let inHtmlComment = false;

  for (const sourceLine of markdown.split('\n')) {
    const sourceFence = sourceLine.match(
      /^ {0,3}(`{3,}|~{3,})/,
    );
    if (fenceCharacter !== undefined) {
      if (
        sourceFence?.[1][0] === fenceCharacter
        && sourceFence[1].length >= fenceLength
        && sourceLine.slice(sourceFence[0].length)
          .trim() === ''
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      visibleLines.push(undefined);
      continue;
    }

    if (!inHtmlComment && sourceFence) {
      fenceCharacter = sourceFence[1][0];
      fenceLength = sourceFence[1].length;
      visibleLines.push(undefined);
      continue;
    }

    let remainder = sourceLine;
    let visible = '';
    while (remainder.length > 0) {
      if (inHtmlComment) {
        const close = remainder.indexOf('-->');
        if (close === -1) {
          remainder = '';
        } else {
          inHtmlComment = false;
          remainder = remainder.slice(close + 3);
        }
      } else {
        const open = remainder.indexOf('<!--');
        if (open === -1) {
          visible += remainder;
          remainder = '';
        } else {
          visible += remainder.slice(0, open);
          inHtmlComment = true;
          remainder = remainder.slice(open + 4);
        }
      }
    }

    const visibleFence = visible.match(
      /^ {0,3}(`{3,}|~{3,})/,
    );
    if (visibleFence) {
      fenceCharacter = visibleFence[1][0];
      fenceLength = visibleFence[1].length;
      visibleLines.push(undefined);
    } else {
      visibleLines.push(visible);
    }
  }

  return visibleLines;
}

function markdownSection(markdown, heading) {
  const visibleLines = visibleMarkdownLines(markdown);
  const marker = `## ${heading}`;
  const starts = visibleLines.flatMap(
    (line, index) => line === marker ? [index] : [],
  );
  assert.equal(
    starts.length,
    1,
    `${heading} section must exist exactly once`,
  );
  const start = starts[0] + 1;
  const nextHeading = visibleLines.findIndex(
    (line, index) => index >= start && /^## /.test(line ?? ''),
  );
  return visibleLines.slice(
    start,
    nextHeading === -1 ? undefined : nextHeading,
  ).filter((line) => line !== undefined).join('\n').trim();
}

test('review taxonomy is versioned, unique, and keeps project policy separate', async () => {
  const catalog = JSON.parse(await read('catalog/review-dimensions.v1.json'));
  assert.equal(catalog.version, 'review-dimensions.v1');
  assert.equal(catalog.dimensions.length, 8);
  const ids = catalog.dimensions.map((dimension) => dimension.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [
    'correctness',
    'wiring',
    'schema-contracts',
    'security',
    'concurrency-atomicity',
    'performance',
    'testing',
    'strict-maintainability',
  ]);
  for (const dimension of catalog.dimensions) {
    assert.match(dimension.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof dimension.title, 'string');
    assert.ok(dimension.title.length > 0);
    assert.equal(typeof dimension.prompt, 'string');
    assert.ok(dimension.prompt.length >= 80);
  }
  assert.equal(JSON.stringify(catalog).includes('Bong'), false);
});

test('defect-first skill and taxonomy separate proven failures from suggestions', async () => {
  const skill = await read('.claude/skills/code-review/SKILL.md');
  const catalog = JSON.parse(await read('catalog/review-dimensions.v1.json'));
  const testing = catalog.dimensions.find((dimension) => dimension.id === 'testing').prompt;
  const maintainability = catalog.dimensions.find((dimension) => dimension.id === 'strict-maintainability').prompt;


  assert.equal(
    createHash('sha256').update(skill).digest('hex'),
    '0bcf468a443cb4e018e782fd4019c0b1c707f840a44e149cffe9ca684f5d6b30',
    'the reviewed defect-first contract must change explicitly',
  );
  assert.match(skill, /^---\nname: code-review\n/);
  assert.match(skill, /disable-model-invocation: true/);
  assert.doesNotMatch(
    skill,
    /<!--|```|~~~/,
    'contract rules must remain directly visible, not hidden in comments or fences',
  );

  const visibleSkill = visibleMarkdownLines(skill)
    .filter((line) => line !== undefined)
    .join('\n');
  const classification = markdownSection(skill, 'Required Classification');
  const allLevelMatches = [...visibleSkill.matchAll(
    /^- \*\*(blocker|major|minor|suggestion)\*\* — (.+)$/gm,
  )];
  const levelMatches = [...classification.matchAll(
    /^- \*\*(blocker|major|minor|suggestion)\*\* — (.+)$/gm,
  )];
  assert.equal(allLevelMatches.length, 4);
  assert.deepEqual(
    allLevelMatches.map((match) => match[0]),
    levelMatches.map((match) => match[0]),
  );
  assert.equal(levelMatches.length, 4);
  assert.equal(
    new Set(levelMatches.map((match) => match[1])).size,
    4,
  );
  const levelDefinitions = Object.fromEntries(
    levelMatches.map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(levelDefinitions, {
    blocker: 'a concrete, reachable defect with catastrophic or release-invalidating impact, including security compromise, authorization bypass, data or resource conservation loss, destructive corruption, or an unusable critical path.',
    major: 'a concrete, reachable correctness, security, permission, user-visible behavior, cross-system contract, or factual documentation defect that should be fixed before merge.',
    minor: 'a reproducible defect with limited impact that is still an objectively wrong result.',
    suggestion: 'there is no demonstrated wrong result. The change could be cleaner, easier to maintain, better named, less repetitive, more defensive, or covered by finer assertions, but its current behavior remains correct.',
  });
  assert.match(
    classification,
    /The finder proposes a level; validators independently recalibrate it\.[\s\S]*Never use review intensity, file size, preferred architecture, or the amount of possible cleanup as a substitute for a concrete failure outcome\./,
  );

  const proofBar = markdownSection(skill, 'Proof Bar');
  assert.match(
    proofBar,
    /^A blocker, major, or minor candidate must identify all of the following:/,
  );
  assert.deepEqual(
    [...proofBar.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]),
    [
      'the input, state, event, or call path that reaches it;',
      'the exact changed code or contract responsible;',
      'the observable wrong result;',
      'why surrounding code, existing validation, or tests do not already prevent it;',
      'why the defect is introduced or exposed by this pull request.',
    ],
  );
  assert.match(
    proofBar,
    /If any element is missing, reject the defect or classify a useful improvement as a suggestion\. Do not report pre-existing unrelated issues\./,
  );

  assert.match(skill, /Report one root cause once/);
  assert.doesNotMatch(skill, /presumptive blockers?/i);
  assert.doesNotMatch(skill, /Do not approve merely because behavior seems correct/i);
  assert.doesNotMatch(skill, /code judo/i);

  assert.match(testing, /concrete incorrect implementation would still pass/);
  assert.match(testing, /falsely claims coverage/);
  assert.match(testing, /finer assertions.*suggestion/);
  assert.match(maintainability, /non-atomic state/);
  assert.match(maintainability, /without a demonstrated wrong result are suggestions/);
  assert.match(maintainability, /never automatic blockers or majors/);
  assert.doesNotMatch(maintainability, /1000 lines/);
});

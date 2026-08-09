import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { STAGE_SCHEMA, stagePrompt } from '../src/claude-runner.mjs';

// Field identifiers the prompts may spell as a natural-language alias instead of
// the exact schema identifier. Exact-match only: a prompt that uses any OTHER
// phrasing for the field fails the guard loudly, forcing an explicit update here
// or in the prompt. It never passes silently.
const FIELD_ALIASES = Object.freeze({
  rootCause: ['root cause'],
});

// Collect every field named by a schema's STATIC `required` arrays: the root
// object plus objects reachable through `properties`/`items`. allOf/if/then/else
// branches are excluded - they are CONDITIONAL requirements (e.g. adjudication
// requires `level` only when decision == "accept"), and the prompts name the
// unconditional fields only.
function collectStaticRequired(schema) {
  const out = new Set();
  function walk(node, isPropertiesMap = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, false);
      return;
    }
    if (isPropertiesMap) {
      for (const value of Object.values(node)) walk(value, false);
      return;
    }
    if (Array.isArray(node.required)) {
      for (const field of node.required) out.add(field);
    }
    if (node.properties && typeof node.properties === 'object') walk(node.properties, true);
    if (node.items) walk(node.items, false);
  }
  walk(schema);
  return [...out];
}

function promptMentions(prompt, field) {
  if (prompt.includes(field)) return true;
  return (FIELD_ALIASES[field] ?? []).some((alias) => prompt.includes(alias));
}

test('every stage prompt names every schema-required field', async () => {
  const centralRoot = process.cwd();
  const context = {
    policy: {},
    repository: 'org/repo',
    skillPath: path.join(centralRoot, '.claude/skills/code-review/SKILL.md'),
    skill: '',
  };
  const stubRequest = {
    plan: { stage: 'plan', shardManifest: [] },
    summary: { stage: 'summary', assignment: {}, diff: '' },
    find: { stage: 'find', taxonomy: {}, summaries: [], paths: [], diff: '' },
    consolidate: { stage: 'consolidate', candidates: [] },
    validate: { stage: 'validate', candidate: {}, relatedDiff: '' },
    adjudicate: { stage: 'adjudicate', candidate: {}, voteRounds: [] },
  };
  for (const stage of Object.keys(STAGE_SCHEMA)) {
    const schema = JSON.parse(await readFile(path.join(centralRoot, 'schemas', STAGE_SCHEMA[stage]), 'utf8'));
    const required = collectStaticRequired(schema).sort();
    const prompt = stagePrompt(stubRequest[stage], context);
    const missing = required.filter((field) => !promptMentions(prompt, field));
    assert.deepEqual(
      missing,
      [],
      `${stage} prompt does not name schema-required field(s): ${missing.join(', ')}`
        + ` (schema requires: ${required.join(', ')}). A schema-required field the model is never told about`
        + ' is how the title/version omissions shipped - name it in the prompt, or add it to FIELD_ALIASES'
        + ' if the prompt spells it in prose.',
    );
  }
});

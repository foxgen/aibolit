'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseContext } = require('../src/protocol');
const { validateScriptRequest } = require('../src/scripts/request');

const file = path.join(__dirname, '..', 'prompts', 'protocol.md');

test('protocol examples are syntactically valid and accepted by their applicable parsers', async () => {
  const markdown = await fs.readFile(file, 'utf8');
  const blocks = [...markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  assert.equal(blocks.length, 4, 'expected file actions, two script requests, and an example result');

  const [files, inline, saved, result] = blocks;
  assert.equal(parseContext(JSON.stringify(files)).actions.length, 2);
  for (const request of [inline, saved]) {
    assert.deepEqual(parseContext(JSON.stringify(request)), request);
    assert.equal(validateScriptRequest(request, [{ name: 'project', path: '/project' }]).payload, request);
  }
  assert.equal(result.version, 1);
  assert.equal(result.kind, 'result');
  assert.equal(result.status, 'success');
});

test('instructions cover critical behaviors and user-visible constraints', async () => {
  const markdown = await fs.readFile(file, 'utf8');
  for (const feature of [
    'Copy code', 'Copy instructions', 'Apply context', 'Output → Copy...',
    'Output → Delete...', 'View script', 'scriptId', 'requestId',
    '128 КиБ', '256 КиБ', '1 МиБ', '2 МиБ', '50 МиБ', '64 КиБ',
    '60 секунд', 'не выполняются', 'не устанавливаются',
    'Base', 'Custom', 'Project', 'Reset instructions',
    'stdout', 'stderr'
  ]) {
    assert.ok(markdown.includes(feature), `instructions must mention: ${feature}`);
  }
});

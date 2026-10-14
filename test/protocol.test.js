'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContext, PROTOCOL_VERSION } = require('../src/protocol');

const actions = { version: PROTOCOL_VERSION, kind: 'actions',
  actions: [{ type: 'createFile', path: 'src/new.js', content: 'export const ok = true;\n' }] };
const script = { version: PROTOCOL_VERSION, kind: 'script', requestId: 'test-1',
  commands: [{ id: 'run', script: { id: 'run', language: 'python', content: 'print(1)\n' } }] };

test('accepts protocol 1 actions and script envelopes', () => {
  assert.deepEqual(parseContext(JSON.stringify(actions)), actions);
  assert.deepEqual(parseContext(JSON.stringify(script)), script);
});

test('accepts only a standalone JSON object or a single fenced JSON block', () => {
  const message = JSON.stringify(actions);
  assert.deepEqual(parseContext('```json\n' + message + '\n```'), actions);
  assert.deepEqual(parseContext('```\n' + message + '\n```'), actions);
  assert.throws(() => parseContext('Here are changes:\n' + message), /только JSON/i);
  assert.throws(() => parseContext('AI_ACTIONS_BEGIN\n' + message + '\nAI_ACTIONS_END'), /только JSON/i);
  assert.throws(() => parseContext(''), /Буфер обмена пуст/i);
});

test('rejects unknown versions, missing kind, response envelopes and mixed messages', () => {
  for (const version of [2, 3, '1', null]) {
    assert.throws(() => parseContext(JSON.stringify({ ...actions, version })), /version/);
  }
  assert.throws(() => parseContext(JSON.stringify({ version: 1, actions: actions.actions })), /kind/);
  assert.throws(() => parseContext(JSON.stringify({ ...actions, kind: 'unknown' })), /kind/);
  for (const kind of ['result', 'results']) {
    assert.throws(() => parseContext(JSON.stringify({ version: 1, kind, commands: [] })), /Apply context/);
  }
  assert.throws(() => parseContext(JSON.stringify({ ...actions, commands: [] })), /без commands/);
  assert.throws(() => parseContext(JSON.stringify({ ...script, actions: [] })), /actions запрещено/);
  assert.throws(() => parseContext(JSON.stringify({ ...actions, actions: [] })), /actions/);
  assert.throws(() => parseContext(JSON.stringify({ ...actions, actions: Array(31).fill(actions.actions[0]) })), /actions/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContext } = require('../src/protocol');

const message = JSON.stringify({
  version: 2,
  actions: [{ type: 'createFile', path: 'src/new.js', content: 'export const ok = true;\n' }]
});

test('accept plain JSON copied from ChatGPT', () => {
  assert.equal(parseContext(message).length, 1);
});

test('accept a single JSON Markdown code block', () => {
  assert.deepEqual(parseContext('```json\n' + message + '\n```'), parseContext(message));
  assert.deepEqual(parseContext('```\n' + message + '\n```'), parseContext(message));
});

test('support old delimited contexts for compatibility', () => {
  const old = `AI_ACTIONS_BEGIN\n${message}\nAI_ACTIONS_END`;
  assert.deepEqual(parseContext(old), parseContext(message));
});

test('reject prose around JSON and malformed input', () => {
  assert.throws(() => parseContext('Here are the changes:\n' + message), /только JSON/i);
  assert.throws(() => parseContext(''), /Буфер обмена пуст/i);
  assert.throws(() => parseContext('{"version":2,"actions":[]}'), /Ожидается/i);
});

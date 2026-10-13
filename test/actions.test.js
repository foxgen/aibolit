'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getActionHandler } = require('../src/actions');

test('action registry: only explicit names are enabled', () => {
  assert.equal(getActionHandler('patch', 1), getActionHandler('applyPatch', 1));
  assert.throws(() => getActionHandler('runScript', 2), /Действие 2: разрешены только/);
  assert.throws(() => getActionHandler('__proto__', 3), /Действие 3: разрешены только/);
});

test('createFile action generates a Buffer without writing a file', () => {
  const create = getActionHandler('createFile', 1);
  assert.equal(create.apply({ content: 'пример\n' }, null, 'src/a.txt', 1).toString(), 'пример\n');
  assert.throws(() => create.apply({ content: 'new' }, Buffer.from('old'), 'src/a.txt', 1), /уже существует/);
});

test('patch action changes a prepared Buffer and rejects mismatched source', () => {
  const patch = getActionHandler('patch', 1);
  const make = line => `--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-${line}\n+new\n`;
  const old = Buffer.from('old\n');
  assert.equal(patch.apply({ path: 'src/a.txt', patch: make('old') }, old, 'src/a.txt', 1).toString(), 'new\n');
  assert.equal(old.toString(), 'old\n');
  assert.throws(() => patch.apply({ path: 'src/a.txt', patch: make('wrong') }, old, 'src/a.txt', 1), /патч не применим/);
});

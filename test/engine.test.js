'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepare, commit } = require('../src/engine');
const { parseContext } = require('../src/protocol');

async function withProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-test-'));
  try { return await callback(root, [{ name: 'project', path: root }]); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const patch = (file, from, to) =>
  `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

test('protocol: accept JSON directly, with an optional Markdown code fence', () => {
  const message = '{"version":1,"kind":"actions","actions":[{"type":"createFile","path":"a.txt","content":"ok"}]}';
  assert.equal(parseContext(message).actions.length, 1);
  assert.equal(parseContext('```json\n' + message + '\n```').actions.length, 1);
  assert.equal(parseContext('```\n' + message + '\n```').actions.length, 1);
  assert.equal(parseContext('  \n' + message + '  \n').actions.length, 1);
  assert.equal(parseContext('\ufeff' + message).actions.length, 1);
  assert.throws(() => parseContext('AI_ACTIONS_BEGIN\n' + message + '\nAI_ACTIONS_END'), /только JSON-объект/);
  assert.throws(() => parseContext(message + '\nextra'), /только JSON-объект/i);
  assert.throws(() => parseContext('Here is JSON:\n```json\n' + message + '\n```'), /только JSON-объект/i);
  assert.throws(() => parseContext('a'.repeat(257 * 1024)), /слишком большой/i);
  assert.throws(() => parseContext('[]'), /ожидается.*version/i);
});

test('create file then patch it in the same frame; commit both', async () => withProject(async (root, roots) => {
  const actions = [
    { type: 'createFile', path: 'src/hello.js', content: 'old\n' },
    { type: 'patch', path: 'src/hello.js', patch: patch('src/hello.js', 'old', 'new') }
  ];
  const plan = await prepare(actions, roots);
  assert.equal(plan.created, 1);
  assert.equal(plan.modified, 0);
  await commit(plan);
  assert.equal(await fs.readFile(path.join(root, 'src/hello.js'), 'utf8'), 'new\n');
}));

test('bad third action means no file changes at all', async () => withProject(async (root, roots) => {
  await fs.writeFile(path.join(root, 'old.txt'), 'hello\n');
  const actions = [
    { type: 'patch', path: 'old.txt', patch: patch('old.txt', 'hello', 'bye') },
    { type: 'createFile', path: 'sub/new.txt', content: 'new\n' },
    { type: 'patch', path: 'sub/new.txt', patch: patch('sub/new.txt', 'nonexistent', 'x') }
  ];
  await assert.rejects(() => prepare(actions, roots), /патч не применим/i);
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'hello\n');
  await assert.rejects(() => fs.stat(path.join(root, 'sub/new.txt')), { code: 'ENOENT' });
}));

test('failure after the first write restores first file and removes new paths', async () => withProject(async (root, roots) => {
  await fs.writeFile(path.join(root, 'old.txt'), 'hello\n');
  const plan = await prepare([
    { type: 'patch', path: 'old.txt', patch: patch('old.txt', 'hello', 'bye') },
    { type: 'createFile', path: 'sub/new.txt', content: 'hello\n' }
  ], roots);
  await assert.rejects(() => commit(plan, {
    afterWrite: (_entry, count) => { if (count === 1) throw new Error('simulated failure'); }
  }), /изменения отменены/i);
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'hello\n');
  await assert.rejects(() => fs.stat(path.join(root, 'sub/new.txt')), { code: 'ENOENT' });
  await assert.rejects(() => fs.stat(path.join(root, 'sub')), { code: 'ENOENT' });
}));

test('detect file changed between prepare and commit', async () => withProject(async (root, roots) => {
  await fs.writeFile(path.join(root, 'old.txt'), 'hello\n');
  const plan = await prepare([
    { type: 'patch', path: 'old.txt', patch: patch('old.txt', 'hello', 'bye') },
    { type: 'createFile', path: 'created.txt', content: 'created' }
  ], roots);
  await fs.writeFile(path.join(root, 'old.txt'), 'edited manually\n');
  await assert.rejects(() => commit(plan), /файл изменился после проверки/i);
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'edited manually\n');
  await assert.rejects(() => fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' });
}));

test('dangerous paths, unknown action, overwrite, and untrusted symlinks rejected', async () => withProject(async (root, roots) => {
  for (const badPath of ['../escape', 'a/../../b', 'C:/secret.txt', 'a\\b', '.git/config', 'src//a', 'CON.txt']) {
    await assert.rejects(() => prepare([{ type: 'createFile', path: badPath, content: 'x' }], roots));
  }
  await assert.rejects(() => prepare([{ type: 'runScript', script: 'test' }], roots), /только createFile и patch/i);
  await fs.writeFile(path.join(root, 'old.txt'), 'hello');
  await assert.rejects(() => prepare([{ type: 'createFile', path: 'old.txt', content: 'no' }], roots), /уже существует/i);
  await fs.symlink(os.tmpdir(), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepare([{ type: 'createFile', path: 'linked/new.txt', content: 'unsafe' }], roots), /символические ссылки/i);
}));

test('dirty editor prevents the entire context from applying', async () => withProject(async (root, roots) => {
  const plan = await prepare([{ type: 'createFile', path: 'new.txt', content: 'new' }], roots);
  await assert.rejects(() => commit(plan, {
    checkDirty: async () => { throw new Error('unsaved buffer'); }
  }), /изменения отменены/i);
  await assert.rejects(() => fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
}));

test('multi-root projects require action.root', async () => withProject(async (root, roots) => {
  const all = [...roots, { name: 'other', path: root }];
  await assert.rejects(() => prepare([{ type: 'createFile', path: 'x', content: 'x' }], all), /поле root/i);
  const plan = await prepare([{ type: 'createFile', root: 'project', path: 'x', content: 'x' }], all);
  assert.equal(plan.created, 1);
}));

test('bare JSON example clipboard context is executable', async () => withProject(async (root, roots) => {
  const envelope = await fs.readFile(path.join(__dirname, '../example-actions.json'), 'utf8');
  const { actions } = parseContext(envelope);
  await commit(await prepare(actions, roots));
  assert.equal(await fs.readFile(path.join(root, 'aibolit-example/greeting.js'), 'utf8'),
    "export const message = 'Hello from Aibolit';\n");
}));

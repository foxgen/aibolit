'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { ensureInstructions, combinedInstructions } = require('../src/instructions');

const template = path.join(__dirname, '..', 'prompts', 'protocol.md');

async function withStorage(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-instructions-test-'));
  try { await callback(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('first use initializes both files, copy includes base with no empty custom separator', async () => {
  await withStorage(async storage => {
    const paths = await ensureInstructions(storage, template);
    assert.equal(await fs.readFile(paths.custom, 'utf8'), '');
    assert.equal(await combinedInstructions(storage, template), (await fs.readFile(template, 'utf8')).trimEnd() + '\n');
  });
});

test('custom rules are appended and changes to base and custom persist', async () => {
  await withStorage(async storage => {
    const files = await ensureInstructions(storage, template);
    await fs.writeFile(files.base, '# My customized protocol\n', 'utf8');
    await fs.writeFile(files.custom, 'Нельзя использовать сторонние библиотеки.\n', 'utf8');
    await ensureInstructions(storage, template);
    const copied = await combinedInstructions(storage, template);
    assert.match(copied, /^# My customized protocol\n/);
    assert.match(copied, /# Дополнительные пользовательские правила/);
    assert.match(copied, /Нельзя использовать сторонние библиотеки/);
    assert.doesNotMatch(copied, /# Aibolit — правила взаимодействия с ИИ/);
  });
});

test('empty base is rejected instead of silently copying only user rules', async () => {
  await withStorage(async storage => {
    const files = await ensureInstructions(storage, template);
    await fs.writeFile(files.base, '  ');
    await assert.rejects(combinedInstructions(storage, template), /Базовые инструкции пусты/);
  });
});

test('template describes both atomic file actions and script execution', async () => {
  const content = await fs.readFile(template, 'utf8');
  assert.match(content, /"version": 1/);
  assert.match(content, /"kind": "actions"/);
  assert.match(content, /"actions": \[/);
  assert.match(content, /"type": "createFile"/);
  assert.match(content, /"type": "patch"/);
  assert.doesNotMatch(content, /"version": [23]/);
  assert.match(content, /"kind": "script"/);
  assert.match(content, /--- a\/src\/new.js/);
});

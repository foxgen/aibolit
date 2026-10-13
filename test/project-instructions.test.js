'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  ensureInstructions, ensureProjectInstructions, combinedInstructions,
  resetInstructions, projectInstructionsPath
} = require('../src/instructions');

const templateFile = path.join(__dirname, '..', 'prompts', 'protocol.md');

async function fixture(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-project-rules-'));
  const storage = path.join(temp, 'global');
  const first = path.join(temp, 'project-a');
  const second = path.join(temp, 'project-b');
  await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
  try { await run({ storage, first, second }); }
  finally { await fs.rm(temp, { force: true, recursive: true }); }
}

test('project instructions are isolated per root, and copying never creates them', async () => {
  await fixture(async ({ storage, first, second }) => {
    const firstRules = await projectInstructionsPath(first);
    const before = await combinedInstructions(storage, templateFile, first);
    assert.match(before, /Aibolit Protocol — версии 2/);
    await assert.rejects(fs.access(firstRules), { code: 'ENOENT' });

    await fs.writeFile(await ensureProjectInstructions(first), 'PROJECT A ONLY\n');
    await fs.writeFile(await ensureProjectInstructions(second), 'PROJECT B ONLY\n');
    const a = await combinedInstructions(storage, templateFile, first);
    const b = await combinedInstructions(storage, templateFile, second);
    const global = await combinedInstructions(storage, templateFile);
    assert.match(a, /PROJECT A ONLY/);
    assert.doesNotMatch(a, /PROJECT B ONLY/);
    assert.match(b, /PROJECT B ONLY/);
    assert.doesNotMatch(b, /PROJECT A ONLY/);
    assert.doesNotMatch(global, /PROJECT A ONLY|PROJECT B ONLY/);
  });
});

test('reset restores base template and clears only the requested layer; backups preserve prior text', async () => {
  await fixture(async ({ storage, first, second }) => {
    const globalFiles = await ensureInstructions(storage, templateFile);
    const firstFile = await ensureProjectInstructions(first);
    const secondFile = await ensureProjectInstructions(second);
    await fs.writeFile(globalFiles.base, 'CUSTOM BASE\n');
    await fs.writeFile(globalFiles.custom, 'CUSTOM GLOBAL\n');
    await fs.writeFile(firstFile, 'PROJECT A\n');
    await fs.writeFile(secondFile, 'PROJECT B\n');

    const base = await resetInstructions({ type: 'base', storageDir: storage, templateFile });
    assert.equal(await fs.readFile(base.backup, 'utf8'), 'CUSTOM BASE\n');
    assert.equal(await fs.readFile(globalFiles.base, 'utf8'), await fs.readFile(templateFile, 'utf8'));
    assert.equal(await fs.readFile(globalFiles.custom, 'utf8'), 'CUSTOM GLOBAL\n');

    const project = await resetInstructions({ type: 'project', storageDir: storage, templateFile, projectRoot: first });
    assert.equal(await fs.readFile(project.backup, 'utf8'), 'PROJECT A\n');
    await assert.rejects(fs.access(firstFile), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.dirname(firstFile)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(secondFile, 'utf8'), 'PROJECT B\n');
    assert.ok(project.backup.startsWith(path.join(storage, 'backups') + path.sep));

    const custom = await resetInstructions({ type: 'custom', storageDir: storage, templateFile });
    assert.equal(await fs.readFile(custom.backup, 'utf8'), 'CUSTOM GLOBAL\n');
    assert.equal(await fs.readFile(globalFiles.custom, 'utf8'), '');
    assert.equal(await fs.readFile(secondFile, 'utf8'), 'PROJECT B\n');
  });
});

test('project reset leaves other files in .aibolit intact', async () => {
  await fixture(async ({ storage, first }) => {
    const projectFile = await ensureProjectInstructions(first);
    const otherFile = path.join(path.dirname(projectFile), 'settings.json');
    await fs.writeFile(projectFile, 'PROJECT RULES\n');
    await fs.writeFile(otherFile, '{"enabled":true}\n');
    const result = await resetInstructions({ type: 'project', storageDir: storage, projectRoot: first });
    assert.equal(await fs.readFile(result.backup, 'utf8'), 'PROJECT RULES\n');
    await assert.rejects(fs.access(projectFile), { code: 'ENOENT' });
    assert.equal(await fs.readFile(otherFile, 'utf8'), '{"enabled":true}\n');
  });
});

test('project reset with no instructions file is a no-op and creates no backup or folder', async () => {
  await fixture(async ({ storage, first }) => {
    const projectFile = await projectInstructionsPath(first);
    const result = await resetInstructions({ type: 'project', storageDir: storage, projectRoot: first });
    assert.equal(result.target, projectFile);
    assert.equal(result.backup, null);
    assert.equal(result.unchanged, true);
    await assert.rejects(fs.access(path.dirname(projectFile)), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(storage, 'backups')), { code: 'ENOENT' });

    await fs.mkdir(path.dirname(projectFile));
    await fs.writeFile(path.join(path.dirname(projectFile), '.gitignore'), '# keep\n');
    const existingDirResult = await resetInstructions({ type: 'project', storageDir: storage, projectRoot: first });
    assert.equal(existingDirResult.unchanged, true);
    assert.equal(await fs.readFile(path.join(path.dirname(projectFile), '.gitignore'), 'utf8'), '# keep\n');
  });
});

test('instruction reset refuses unknown types and missing project root', async () => {
  await fixture(async ({ storage }) => {
    await assert.rejects(resetInstructions({ type: 'other', storageDir: storage, templateFile }), /Неизвестный тип/);
    await assert.rejects(resetInstructions({ type: 'project', storageDir: storage, templateFile }), /откройте папку проекта/);
  });
});

test('project instruction folders must not be symbolic links', { skip: process.platform === 'win32' }, async () => {
  await fixture(async ({ storage, first, second }) => {
    await fs.symlink(second, path.join(first, '.aibolit'), 'dir');
    await assert.rejects(combinedInstructions(storage, templateFile, first), /символической ссылкой/);
    await assert.rejects(ensureProjectInstructions(first), /символической ссылкой/);
  });
});

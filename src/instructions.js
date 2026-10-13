'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INSTRUCTIONS_BYTES = 128 * 1024;
const FILES = Object.freeze({ base: 'protocol.md', custom: 'custom.md' });
const PROJECT_DIR = '.aibolit';
const PROJECT_FILE = 'instructions.md';

function instructionPaths(storageDir) {
  return {
    base: path.join(storageDir, FILES.base),
    custom: path.join(storageDir, FILES.custom)
  };
}

async function createOnce(file, content) {
  try {
    await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// Personal copies live outside the installed extension, so upgrades preserve edits.
async function ensureInstructions(storageDir, templateFile) {
  await fs.mkdir(storageDir, { recursive: true });
  const files = instructionPaths(storageDir);
  await createOnce(files.base, await fs.readFile(templateFile, 'utf8'));
  await createOnce(files.custom, '');
  return files;
}

async function projectInstructionsPath(projectRoot, create = false) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('Для проектных инструкций откройте папку проекта.');
  }
  const folder = path.join(projectRoot, PROJECT_DIR);
  const file = path.join(folder, PROJECT_FILE);

  if (create) {
    try { await fs.mkdir(folder); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  let folderStat;
  try { folderStat = await fs.lstat(folder); }
  catch (error) {
    if (!create && error.code === 'ENOENT') return file;
    throw error;
  }
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) {
    throw new Error('Папка .aibolit должна быть обычным каталогом, не символической ссылкой.');
  }
  try {
    const fileStat = await fs.lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('.aibolit/instructions.md должен быть обычным файлом.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return file;
}

async function ensureProjectInstructions(projectRoot) {
  const file = await projectInstructionsPath(projectRoot, true);
  await createOnce(file, '');
  return file;
}

async function readProjectInstructions(projectRoot) {
  if (!projectRoot) return '';
  const file = await projectInstructionsPath(projectRoot);
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

// Project rules are optional: copying instructions never creates project files.
async function combinedInstructions(storageDir, templateFile, projectRoot = null) {
  const files = await ensureInstructions(storageDir, templateFile);
  const [base, custom, project] = await Promise.all([
    fs.readFile(files.base, 'utf8'),
    fs.readFile(files.custom, 'utf8'),
    readProjectInstructions(projectRoot)
  ]);
  if (!base.trim()) {
    throw new Error('Базовые инструкции пусты. Откройте Edit instructions и восстановите protocol.md.');
  }
  let result = base.trimEnd();
  if (custom.trim()) result += '\n\n---\n\n# Дополнительные пользовательские правила\n\n' + custom.trim();
  if (project.trim()) result += '\n\n---\n\n# Правила текущего проекта\n\n' + project.trim();
  result += '\n';
  if (Buffer.byteLength(result, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    throw new Error('Инструкции превышают 128 КиБ. Сократите protocol.md, custom.md или проектные правила.');
  }
  return result;
}

// Keep backups outside Git. Project reset removes its file entirely; Base
// is restored from the bundled template and Custom remains an empty file.
async function resetInstructions({ type, storageDir, templateFile, projectRoot }) {
  let target;
  if (type === 'project') {
    // Do not create .aibolit/ or instructions.md merely to reset them.
    target = await projectInstructionsPath(projectRoot);
    try {
      await fs.access(target);
    } catch (error) {
      if (error.code === 'ENOENT') return { target, backup: null, unchanged: true };
      throw error;
    }
  } else if (type === 'base' || type === 'custom') {
    target = (await ensureInstructions(storageDir, templateFile))[type];
  } else {
    throw new Error(`Неизвестный тип инструкций: ${type}`);
  }

  const backupDir = path.join(storageDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const suffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const backup = path.join(backupDir, `${type}-${suffix}.md`);
  await fs.copyFile(target, backup, fs.constants.COPYFILE_EXCL);

  if (type === 'project') {
    // A successful backup must exist before deleting anything in the project.
    await fs.unlink(target);
    try {
      await fs.rmdir(path.dirname(target));
    } catch (error) {
      // Preserve the directory if it contains anything else (.gitignore, etc.).
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
    }
    return { target, backup, unchanged: false };
  }

  const replacement = type === 'base' ? await fs.readFile(templateFile) : Buffer.alloc(0);
  const temporary = `${target}.aibolit-${suffix}.tmp`;
  try {
    await fs.writeFile(temporary, replacement, { flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    try { await fs.unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { target, backup, unchanged: false };
}

module.exports = {
  ensureInstructions,
  ensureProjectInstructions,
  combinedInstructions,
  instructionPaths,
  projectInstructionsPath,
  resetInstructions,
  MAX_INSTRUCTIONS_BYTES
};

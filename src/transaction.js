'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectPath } = require('./file-access');

async function assertUnchanged(entry) {
  const state = await inspectPath(entry.rootPath, entry.segments);
  if (state.absolute !== entry.path) throw new Error(`Изменён путь: ${entry.display}`);

  if (entry.before === null) {
    if (state.exists) throw new Error(`Файл появился извне: ${entry.display}`);
  } else {
    if (!state.exists) throw new Error(`Файл исчез: ${entry.display}`);
    if (!(await fs.readFile(entry.path)).equals(entry.before)) {
      throw new Error(`Файл изменился после проверки: ${entry.display}`);
    }
  }
}

async function ensureFolders(entry, createdDirs) {
  let current = entry.rootPath;
  for (const segment of entry.segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Небезопасная папка: ${current}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
      createdDirs.push(current);
    }
  }
}

async function removeIfExists(file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function stageFile(entry, createdDirs, staged) {
  await ensureFolders(entry, createdDirs);
  const suffix = `.aibolit-${crypto.randomBytes(12).toString('hex')}`;
  entry.temp = entry.path + suffix + '.tmp';
  entry.backup = entry.before === null ? null : entry.path + suffix + '.bak';
  staged.push(entry); // Включаем до записи, чтобы убрать даже неполный .tmp.

  await fs.writeFile(entry.temp, entry.after, { flag: 'wx', mode: entry.beforeMode || 0o666 });
  if (entry.backup) {
    await fs.writeFile(entry.backup, entry.before, { flag: 'wx', mode: entry.beforeMode });
  }
}

async function publishFile(entry) {
  await assertUnchanged(entry);
  if (entry.before === null) {
    // Создание только при отсутствии файла. При гонке получим EEXIST.
    await fs.link(entry.temp, entry.path);
  } else {
    await fs.rename(entry.temp, entry.path);
  }
}

async function restoreWritten(written) {
  const problems = [];
  for (const entry of written.reverse()) {
    try {
      if (entry.before === null) await removeIfExists(entry.path);
      else await fs.rename(entry.backup, entry.path);
    } catch (error) {
      problems.push(`${entry.display}: ${error.message}; backup: ${entry.backup}`);
    }
  }
  return problems;
}

async function cleanup(staged, createdDirs, keepBackups) {
  for (const entry of staged) {
    try { await removeIfExists(entry.temp); } catch { /* Оставляем для ручной диагностики. */ }
    if (entry.backup && !keepBackups) {
      try { await removeIfExists(entry.backup); } catch { /* Копию можно восстановить вручную. */ }
    }
  }
  for (const directory of createdDirs.reverse()) {
    try { await fs.rmdir(directory); } catch { /* Мог остаться созданный файл. */ }
  }
}

/**
 * Commit: проверить неизменность файлов -> подготовить .tmp/.bak -> записать.
 * При ошибке пытаемся вернуть записанные файлы в исходное состояние.
 * Это НЕ пользовательский Undo и не гарантия атомарности при отключении питания.
 */
async function commit(plan, {
  checkDirty = async () => {},
  beforeWrite = async () => {},
  afterWrite = async () => {}
} = {}) {
  const createdDirs = [];
  const staged = [];
  const written = [];
  let rollbackFailure = null;

  try {
    await checkDirty(plan.changes);
    for (const entry of plan.changes) await assertUnchanged(entry);
    for (const entry of plan.changes) await stageFile(entry, createdDirs, staged);

    await checkDirty(plan.changes);
    for (const entry of plan.changes) await assertUnchanged(entry);
    await beforeWrite(); // Тестовый hook для имитации сбоя записи.

    for (const entry of plan.changes) {
      await publishFile(entry);
      written.push(entry);
      await afterWrite(entry, written.length); // Тестовый hook.
    }
  } catch (error) {
    const problems = await restoreWritten(written);
    if (problems.length) {
      rollbackFailure = new Error(`Не удалось полностью восстановить исходное состояние. ${problems.join('; ')}`);
      throw new Error(`Ошибка применения: ${error.message}. ВНИМАНИЕ: ${rollbackFailure.message}`);
    }
    throw new Error(`Контекст не принят; изменения отменены. Причина: ${error.message}`);
  } finally {
    await cleanup(staged, createdDirs, Boolean(rollbackFailure));
  }

  return { created: plan.created, modified: plan.modified };
}

module.exports = { commit };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LANGUAGES } = require('./request');

const MAX_HISTORY_BYTES = 50 * 1024 * 1024;

function folders(storage) {
  return { scripts: path.join(storage, 'scripts'), runs: path.join(storage, 'runs') };
}

async function initStorage(storage) {
  const names = folders(storage);
  await fs.mkdir(names.scripts, { recursive: true });
  await fs.mkdir(names.runs, { recursive: true });
  return names;
}

function shaScript(language, content) {
  return crypto.createHash('sha256').update(language + '\0' + content).digest('hex');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function writeJson(file, object) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(object, null, 2) + '\n', { flag: 'wx' });
  try { await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}

async function loadScripts(storage) {
  const { scripts } = await initStorage(storage);
  return await readJson(path.join(scripts, 'index.json'), {});
}

async function saveScripts(storage, scriptsToSave, approvals) {
  const { scripts } = await initStorage(storage);
  const index = await loadScripts(storage);
  for (const record of scriptsToSave) {
    const dir = path.join(scripts, record.id);
    await fs.mkdir(dir, { recursive: true });
    const name = record.hash + LANGUAGES[record.language];
    const file = path.join(dir, name);
    try { await fs.writeFile(file, record.content, { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    index[record.id] = { language: record.language, hash: record.hash, file: path.relative(scripts, file) };
  }
  await writeJson(path.join(scripts, 'index.json'), index);
  await writeJson(path.join(scripts, 'approvals.json'), approvals);
  return index;
}

async function readApprovals(storage) {
  const { scripts } = await initStorage(storage);
  return await readJson(path.join(scripts, 'approvals.json'), {});
}

async function resolveStored(storage, id, index) {
  const record = index[id];
  if (!record || !LANGUAGES[record.language] || !/^[a-f0-9]{64}$/.test(record.hash)) {
    throw new Error(`Скрипт не найден: ${id}`);
  }
  const expected = path.join(id, record.hash + LANGUAGES[record.language]);
  if (record.file !== expected) throw new Error(`Некорректная запись скрипта: ${id}`);
  const file = path.join(folders(storage).scripts, expected);
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Скрипт повреждён: ${id}`);
  const content = await fs.readFile(file, 'utf8');
  if (shaScript(record.language, content) !== record.hash) throw new Error(`Скрипт изменён вне Aibolit: ${id}`);
  return { id, language: record.language, content, hash: record.hash, file };
}

async function listRuns(storage) {
  const { runs } = await initStorage(storage);
  const names = await fs.readdir(runs, { withFileTypes: true });
  const results = [];
  for (const item of names) {
    if (!item.isDirectory() || !/^exec-[0-9a-f-]{36}$/.test(item.name)) continue;
    try {
      const dir = path.join(runs, item.name);
      const result = await readJson(path.join(dir, 'result.json'), null);
      if (result) results.push({ dir, result });
    } catch { /* Corrupt record does not block other history entries. */ }
  }
  return results.sort((a, b) => String(b.result.startedAt || '').localeCompare(String(a.result.startedAt || '')));
}

async function usedStorageBytes(dir) {
  let total = 0;
  async function scan(folder) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await scan(file);
      else total += stat.size;
    }
  }
  try { await scan(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return total;
}

async function requireHistorySpace(storage) {
  const count = await usedStorageBytes(folders(storage).runs);
  if (count >= MAX_HISTORY_BYTES) throw new Error('История запусков достигла 50 МиБ. Используйте Copy output → Clear outputs.');
  return MAX_HISTORY_BYTES - count;
}

module.exports = {
  folders, initStorage, shaScript, readJson, writeJson, loadScripts, saveScripts,
  readApprovals, resolveStored, listRuns, usedStorageBytes, requireHistorySpace, MAX_HISTORY_BYTES
};

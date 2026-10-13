'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { listRuns, folders } = require('./storage');

const MAX_CLIPBOARD_BYTES = 64 * 1024;

function shrink(text, bytes) {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return { text, truncated: false };
  const characters = Array.from(text);
  // Keep both beginning and end: tail usually contains the actionable error.
  let left = 0;
  let right = characters.length;
  while (left < right) {
    const middle = Math.floor((left + right + 1) / 2);
    const begin = Math.ceil(middle * 0.3);
    const end = middle - begin;
    const cut = characters.slice(0, begin).join('') + '\n...[output truncated]...\n' + characters.slice(-end).join('');
    if (Buffer.byteLength(cut, 'utf8') <= bytes) left = middle;
    else right = middle - 1;
  }
  const begin = Math.ceil(left * 0.3);
  const end = left - begin;
  return { text: characters.slice(0, begin).join('') + '\n...[output truncated]...\n' + (end ? characters.slice(-end).join('') : ''), truncated: true };
}

async function toAIResult(item, limit = MAX_CLIPBOARD_BYTES) {
  const stored = item.result;
  const output = {
    version: 3, kind: 'result', requestId: stored.requestId,
    executionId: stored.executionId, status: stored.status, commands: []
  };
  const candidates = [];
  for (const cmd of stored.commands) {
    const entry = { id: cmd.id, scriptId: cmd.scriptId, status: cmd.status,
      exitCode: cmd.exitCode ?? null };
    if (cmd.reason) entry.reason = cmd.reason;
    if (cmd.error) entry.error = cmd.error;
    if (cmd.status !== 'skipped') {
      for (const stream of ['stdout', 'stderr']) {
        const filename = path.join(item.dir, 'commands', cmd.id, stream + '.log');
        let text;
        try { text = await fs.readFile(filename, 'utf8'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; text = ''; }
        // Remove terminal formatting sequences and control chars before copying.
        const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u0000/g, '');
        entry[stream] = clean;
        candidates.push({ entry, stream, clean });
      }
      entry.truncated = Boolean(cmd.truncated);
    }
    output.commands.push(entry);
  }
  let json = JSON.stringify(output, null, 2);
  if (Buffer.byteLength(json, 'utf8') > limit) {
    // JSON escaping can expand text, so reduce the budget until the serialized
    // payload actually fits, rather than estimating UTF-8 text length once.
    let budget = Math.max(0, limit - 1024);
    for (let attempt = 0; attempt < 24; attempt++) {
      const share = Math.floor(budget / Math.max(candidates.length, 1));
      for (const candidate of candidates) {
        const reduced = shrink(candidate.clean, share);
        candidate.entry[candidate.stream] = reduced.text;
        candidate.entry.truncated ||= reduced.truncated;
      }
      json = JSON.stringify(output, null, 2);
      if (Buffer.byteLength(json, 'utf8') <= limit) break;
      budget = Math.floor(budget * 0.75);
    }
  }
  if (Buffer.byteLength(json, 'utf8') > limit) {
    // Large command counts still have a minimum JSON metadata cost.
    throw new Error('Результат не помещается в лимит буфера обмена. Выберите меньше запусков.');
  }
  return json;
}

async function listOutputEntries(storage) { return await listRuns(storage); }

async function clearOutputs(storage, executionIds) {
  const existing = await listRuns(storage);
  const chosen = new Set(executionIds);
  let removed = 0;
  for (const run of existing) {
    if (chosen.has(run.result.executionId)) {
      // Directory comes only from a validated ID returned by listRuns.
      await fs.rm(run.dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

async function clearAllOutputs(storage) {
  const runs = folders(storage).runs;
  let removed = 0;
  for (const item of await fs.readdir(runs, { withFileTypes: true })) {
    if (item.isDirectory() && /^exec-[0-9a-f-]{36}$/.test(item.name)) {
      await fs.rm(path.join(runs, item.name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

module.exports = { toAIResult, listOutputEntries, clearOutputs, clearAllOutputs, MAX_CLIPBOARD_BYTES, shrink };

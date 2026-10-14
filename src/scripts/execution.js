'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateScriptRequest } = require('./request');
const { initStorage, shaScript, loadScripts, saveScripts, readApprovals,
  resolveStored, listRuns, requireHistorySpace, folders, writeJson, readJson } = require('./storage');
const { runScript } = require('./runner');
const { PROTOCOL_VERSION } = require('../protocol');

const DEFAULT_COMMANDS = { python: 'python', bash: 'bash', powershell: 'pwsh' };

// Preflight validates ALL commands but neither prompts nor persists scripts.
// In particular, a script after a failed command must not be saved or approved.
async function prepareExecution(payload, roots, storage, authorize) {
  const { root } = validateScriptRequest(payload, roots);
  if (typeof authorize !== 'function') throw new Error('Не задан обработчик подтверждения скриптов.');
  await initStorage(storage);
  const previous = await listRuns(storage);
  const matching = previous.find(item => item.result.requestId === payload.requestId);
  if (matching) {
    const old = await readJson(path.join(matching.dir, 'request.json'), null);
    if (JSON.stringify(old) !== JSON.stringify(payload)) {
      throw new Error('requestId уже использован для другого запроса.');
    }
  }

  const index = await loadScripts(storage);
  const steps = [];
  const inline = new Map();
  for (const cmd of payload.commands) {
    let script;
    if (cmd.script) {
      script = { id: cmd.script.id, language: cmd.script.language, content: cmd.script.content };
      script.hash = shaScript(script.language, script.content);
      inline.set(script.id, script);
    } else {
      script = inline.get(cmd.scriptId) || await resolveStored(storage, cmd.scriptId, index);
    }
    steps.push({ id: cmd.id, scriptId: script.id, language: script.language,
      hash: script.hash, args: cmd.args || [], script });
  }
  return { root, previous: matching, steps, payload, authorize };
}

// Approval and script persistence happen only when execution reaches a step.
async function approveAndStore(step, prepared, storage) {
  const approvals = await readApprovals(storage);
  // Bind consent to exact code, workspace and arguments.
  const approvalHash = crypto.createHash('sha256')
    .update(step.hash + '\0' + prepared.root.path + '\0' + JSON.stringify(step.args)).digest('hex');
  const approved = approvals[step.scriptId] === approvalHash;
  if (!approved && !await prepared.authorize(step.script, { args: step.args, cwd: prepared.root.path })) return null;

  // Referenced scripts already have a file on disk. Inline scripts are stored
  // only when their step is reached (never during preflight).
  if (!step.script.file || !approved) {
    const updatedApprovals = { ...approvals, [step.scriptId]: approvalHash };
    await saveScripts(storage, step.script.file ? [] : [step.script], updatedApprovals);
  }
  const stored = await resolveStored(storage, step.scriptId, await loadScripts(storage));
  // The file must still be the version that was reviewed (or pre-approved).
  if (stored.hash !== step.hash || stored.language !== step.language) {
    throw new Error(`Скрипт изменился после подтверждения: ${step.scriptId}`);
  }
  return stored;
}

async function executeScripts(prepared, storage, interpreterCommands = {}) {
  await requireHistorySpace(storage);
  const executionId = 'exec-' + crypto.randomUUID();
  const directory = path.join(folders(storage).runs, executionId);
  await fs.mkdir(directory, { recursive: false });
  const result = {
    version: PROTOCOL_VERSION, kind: 'result', requestId: prepared.payload.requestId, executionId,
    root: prepared.root.name, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    commands: prepared.steps.map(step => ({ id: step.id, scriptId: step.scriptId,
      language: step.language, scriptSha256: step.hash, status: 'skipped', reason: 'previous_command_failed' }))
  };
  const resultFile = path.join(directory, 'result.json');
  // request.json intentionally preserves the original context for diagnosis.
  // Skipped scripts are NOT installed in scripts/ and receive no approvals.
  await writeJson(path.join(directory, 'request.json'), prepared.payload);
  await writeJson(resultFile, result);
  try {
    for (let i = 0; i < prepared.steps.length; i++) {
      const step = prepared.steps[i];
      const record = result.commands[i];
      record.status = 'pending_approval';
      delete record.reason;
      await writeJson(resultFile, result);

      // No prompt for subsequent commands if an earlier command failed.
      const script = await approveAndStore(step, prepared, storage);
      if (!script) {
        record.status = 'denied';
        record.reason = 'user_denied';
        record.exitCode = null;
        await writeJson(resultFile, result);
        break;
      }

      const remainingSpace = await requireHistorySpace(storage);
      record.status = 'running';
      await writeJson(resultFile, result);
      const outputDir = path.join(directory, 'commands', step.id);
      const outcome = await runScript({ script, args: step.args, cwd: prepared.root.path,
        outputDir, executable: interpreterCommands[step.language] || DEFAULT_COMMANDS[step.language],
        maxOutputBytes: Math.min(2 * 1024 * 1024, Math.max(0, remainingSpace - 4096)) });
      Object.assign(record, outcome);
      await writeJson(resultFile, result);
      if (outcome.status !== 'success') break;
    }
    result.status = result.commands.every(item => item.status === 'success') ? 'success' : 'failed';
  } catch (error) {
    result.status = 'failed';
    const active = result.commands.find(item => item.status === 'running' || item.status === 'pending_approval');
    if (active) { active.status = 'start_error'; active.error = error.message; active.exitCode = null; }
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeJson(resultFile, result);
  }
  return { dir: directory, result };
}

module.exports = { prepareExecution, executeScripts, DEFAULT_COMMANDS };

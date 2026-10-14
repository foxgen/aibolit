'use strict';

const { PROTOCOL_VERSION } = require('../protocol');

const LANGUAGES = Object.freeze({ python: '.py', bash: '.sh', powershell: '.ps1' });
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function validateScriptRequest(payload, roots) {
  if (!payload || payload.version !== PROTOCOL_VERSION || payload.kind !== 'script' || payload.actions !== undefined ||
      !IDENTIFIER.test(payload.requestId || '') || !Array.isArray(payload.commands) ||
      payload.commands.length < 1 || payload.commands.length > 20) {
    throw new Error(`Нужен JSON version:${PROTOCOL_VERSION}, kind:"script", requestId и 1–20 commands.`);
  }
  if (!Array.isArray(roots) || !roots.length) throw new Error('Откройте папку проекта.');
  const root = roots.length === 1
    ? roots[0]
    : roots.find(item => item.name === payload.root);
  if (!root || (payload.root && payload.root !== root.name) ||
      (roots.length > 1 && roots.filter(item => item.name === payload.root).length !== 1)) {
    throw new Error('Для нескольких корней workspace укажите уникальное поле root.');
  }
  const ids = new Set();
  const scriptVersions = new Map();
  for (const cmd of payload.commands) {
    if (!cmd || !IDENTIFIER.test(cmd.id || '') || ids.has(cmd.id)) {
      throw new Error('Каждой команде необходим уникальный id: буквы, цифры, _ или -.');
    }
    ids.add(cmd.id);
    const hasInline = cmd.script !== undefined;
    const hasSaved = cmd.scriptId !== undefined;
    if (hasInline === hasSaved) throw new Error(`${cmd.id}: укажите ровно одно из script или scriptId.`);
    const script = hasInline ? cmd.script : null;
    const scriptId = hasInline ? script?.id : cmd.scriptId;
    if (!IDENTIFIER.test(scriptId || '')) throw new Error(`${cmd.id}: неправильный scriptId.`);
    if (hasInline) {
      if (!LANGUAGES[script.language] || typeof script.content !== 'string' || !script.content.trim() ||
          Buffer.byteLength(script.content, 'utf8') > 128 * 1024) {
        throw new Error(`${cmd.id}: ожидается непустой скрипт Python/Bash/PowerShell до 128 КиБ.`);
      }
      const previous = scriptVersions.get(scriptId);
      if (previous && (previous.content !== script.content || previous.language !== script.language)) {
        throw new Error(`scriptId ${scriptId} переопределён в одном запросе.`);
      }
      scriptVersions.set(scriptId, script);
    }
    if (cmd.args !== undefined && (!Array.isArray(cmd.args) || cmd.args.length > 20 ||
        cmd.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0')))) {
      throw new Error(`${cmd.id}: args должен быть массивом коротких строк.`);
    }
  }
  return { root, payload };
}

module.exports = { validateScriptRequest, LANGUAGES, IDENTIFIER };

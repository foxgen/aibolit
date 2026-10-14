'use strict';

const PROTOCOL_VERSION = 1;
const MAX_CLIPBOARD_BYTES = 256 * 1024;
const MAX_ACTIONS = 30;

// Accept one JSON object, optionally wrapped in exactly one Markdown fence.
// Extra prose, old delimiters and obsolete protocol versions are not commands.
function extractJson(clipboard) {
  let text = clipboard.trim().replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  if (fence) text = fence[1].trim();
  return text;
}

function parseContext(clipboard) {
  if (typeof clipboard !== 'string' || !clipboard.trim()) {
    throw new Error('Буфер обмена пуст. Скопируйте один JSON-объект протокола Aibolit.');
  }
  const size = Buffer.byteLength(clipboard, 'utf8');
  if (size > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Контекст слишком большой (${size} байт; максимум ${MAX_CLIPBOARD_BYTES}).`);
  }
  let payload;
  try { payload = JSON.parse(extractJson(clipboard)); }
  catch (error) {
    throw new Error(`Ожидается только JSON-объект без пояснений вокруг. Некорректный JSON: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.version !== PROTOCOL_VERSION) {
    throw new Error(`Ожидается JSON-объект с числовым version: ${PROTOCOL_VERSION} и kind: "actions" или "script".`);
  }
  if (payload.kind === 'actions') {
    if (!Array.isArray(payload.actions) || payload.actions.length < 1 ||
        payload.actions.length > MAX_ACTIONS || payload.commands !== undefined ||
        payload.requestId !== undefined) {
      throw new Error(`Для kind:"actions" требуется 1–${MAX_ACTIONS} actions, без commands и requestId.`);
    }
  } else if (payload.kind === 'script') {
    if (payload.actions !== undefined) {
      throw new Error('Для kind:"script" поле actions запрещено.');
    }
    // Detailed script validation is performed by src/scripts/request.js.
  } else {
    throw new Error('Apply context принимает только kind:"actions" или kind:"script" (не result/results).');
  }
  return payload;
}

module.exports = { parseContext, PROTOCOL_VERSION, MAX_CLIPBOARD_BYTES, MAX_ACTIONS };

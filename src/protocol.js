'use strict';

const MAX_CLIPBOARD_BYTES = 256 * 1024;
const MAX_ACTIONS = 30;

// Допустимы только самостоятельный JSON или один Markdown-блок с JSON.
// Текст вокруг блока не игнорируем: он не должен случайно стать командой.
function extractJson(clipboard) {
  let text = clipboard.trim().replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(text);
  if (fence) text = fence[1].trim();

  // Совместимость с ранними версиями Aibolit.
  const legacy = /^AI_ACTIONS_BEGIN\r?\n([\s\S]*?)\r?\nAI_ACTIONS_END$/.exec(text);
  if (legacy) text = legacy[1].trim();
  return text;
}

function parseContext(clipboard) {
  if (typeof clipboard !== 'string' || !clipboard.trim()) {
    throw new Error('Буфер обмена пуст. Скопируйте JSON с полями version и actions.');
  }

  const size = Buffer.byteLength(clipboard, 'utf8');
  if (size > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Контекст слишком большой (${size} байт; максимум ${MAX_CLIPBOARD_BYTES}).`);
  }

  let payload;
  try {
    payload = JSON.parse(extractJson(clipboard));
  } catch (error) {
    throw new Error(`Ожидается только JSON-объект с действиями, без пояснений вокруг. Некорректный JSON: ${error.message}`);
  }

  if (payload && !Array.isArray(payload) && payload.version === 3 && payload.kind === 'script') {
    return payload; // Script requests are validated by src/scripts/request.js.
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.version !== 2 || !Array.isArray(payload.actions) ||
      payload.actions.length < 1 || payload.actions.length > MAX_ACTIONS) {
    throw new Error(`Ожидается {"version":2,"actions":[...]} или version:3, kind:script.`);
  }
  return payload.actions;
}

module.exports = { parseContext, MAX_CLIPBOARD_BYTES, MAX_ACTIONS };

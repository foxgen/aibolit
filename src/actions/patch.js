'use strict';

const { applyPatch, parsePatch } = require('diff');
const { decodeUtf8 } = require('../file-access');

const MAX_PATCH_BYTES = 256 * 1024;

function checkedPatch(action) {
  if (typeof action.patch !== 'string' || !action.patch.trim() ||
      Buffer.byteLength(action.patch, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`Патч пустой или превышает 256 КиБ: ${action.path}`);
  }

  const parsed = parsePatch(action.patch);
  if (parsed.length !== 1 || !parsed[0].hunks || !parsed[0].hunks.length) {
    throw new Error(`Патч должен содержать изменения ровно одного файла: ${action.path}`);
  }

  const patch = parsed[0];
  if (patch.isRename || patch.isCopy || patch.isCreate || patch.isDelete ||
      patch.oldMode || patch.newMode ||
      patch.oldFileName === '/dev/null' || patch.newFileName === '/dev/null') {
    throw new Error('Патч не должен создавать, удалять, переименовывать файлы или менять права.');
  }

  const withoutPrefix = name => (name || '').replace(/^[ab]\//, '');
  if (withoutPrefix(patch.oldFileName) !== action.path ||
      withoutPrefix(patch.newFileName) !== action.path) {
    throw new Error(`Имена файлов в заголовке патча не совпадают с path: ${action.path}`);
  }
  return patch;
}

function apply(action, current, display, number) {
  if (current === null) {
    throw new Error(`Действие ${number}: файл не существует: ${display}`);
  }

  const text = decodeUtf8(current, display);
  const next = applyPatch(text, checkedPatch(action), { fuzzFactor: 0 });
  if (next === false || next === text) {
    throw new Error(`Действие ${number}: патч не применим к ${display} или не меняет содержимое.`);
  }

  const result = Buffer.from(next, 'utf8');
  decodeUtf8(result, display);
  return result;
}

module.exports = { apply, MAX_PATCH_BYTES };

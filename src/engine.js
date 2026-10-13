'use strict';

const fs = require('node:fs/promises');
const { getActionHandler } = require('./actions');
const { MAX_PATCH_BYTES } = require('./actions/patch');
const { MAX_FILE_BYTES, relativeSegments, selectRoot, inspectPath, decodeUtf8 } = require('./file-access');
const { commit } = require('./transaction');

/**
 * Prepare — без записи в проект: читаем исходники и последовательно вычисляем
 * конечное содержимое каждого затронутого файла.
 * Commit вызывается только после успешной подготовки ВСЕХ действий.
 */
async function prepare(actions, roots) {
  const files = new Map();

  for (const [index, action] of actions.entries()) {
    const handler = getActionHandler(action?.type, index + 1);
    const folder = selectRoot(action, roots);
    const segments = relativeSegments(action.path);
    const inspected = await inspectPath(folder.path, segments);
    const key = process.platform === 'win32' ? inspected.absolute.toLowerCase() : inspected.absolute;

    let entry = files.get(key);
    if (!entry) {
      const original = inspected.exists ? await fs.readFile(inspected.absolute) : null;
      if (original) decodeUtf8(original, action.path);
      entry = {
        path: inspected.absolute,
        rootPath: await fs.realpath(folder.path),
        segments,
        display: roots.length > 1 ? `${folder.name}/${action.path}` : action.path,
        before: original,
        after: original,
        beforeMode: inspected.stat?.mode
      };
      files.set(key, entry);
    }

    // Каждый обработчик работает с результатом предыдущего действия над файлом.
    entry.after = handler.apply(action, entry.after, entry.display, index + 1);
  }

  const changes = [...files.values()].filter(entry =>
    entry.before === null || !entry.after.equals(entry.before)
  );
  if (!changes.length) throw new Error('Нет файловых изменений.');

  return {
    changes,
    created: changes.filter(entry => entry.before === null).length,
    modified: changes.filter(entry => entry.before !== null).length
  };
}

// Сохраняем публичный API: extension.js и существующие тесты менять не нужно.
module.exports = { prepare, commit, relativeSegments, MAX_FILE_BYTES, MAX_PATCH_BYTES };

'use strict';

const createFile = require('./create-file');
const patch = require('./patch');

// Новое файловое действие: добавьте модуль с apply(...) и запишите его здесь.
// apply получает Buffer|null и возвращает новый Buffer; запись выполняет transaction.js.
const handlers = Object.freeze({
  createFile,
  patch,
  applyPatch: patch // Старое название поддерживаем для совместимости.
});

function getActionHandler(type, number) {
  const handler = Object.hasOwn(handlers, type) ? handlers[type] : undefined;
  if (!handler) {
    throw new Error(`Действие ${number}: разрешены только createFile и patch (applyPatch). Скрипты в файловой транзакции запрещены.`);
  }
  return handler;
}

module.exports = { getActionHandler };

'use strict';

const { decodeUtf8 } = require('../file-access');

// Обработчик изменяет только подготовленное содержимое, но не файловую систему.
function apply(action, current, display, number) {
  if (current !== null) {
    throw new Error(`Действие ${number}: файл уже существует: ${display}`);
  }
  if (typeof action.content !== 'string') {
    throw new Error('createFile: content должен быть строкой.');
  }

  const next = Buffer.from(action.content, 'utf8');
  decodeUtf8(next, display); // Проверка кодировки и лимита 1 МиБ.
  return next;
}

module.exports = { apply };

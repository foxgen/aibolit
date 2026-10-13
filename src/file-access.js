'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 1024 * 1024;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const DISALLOWED = /[<>:"|?*\x00-\x1f]/;

function relativeSegments(relative) {
  if (typeof relative !== 'string' || !relative.length || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error(`Нужен относительный путь через /: ${String(relative)}`);
  }

  const segments = relative.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' ||
        segment.toLowerCase() === '.git' || DISALLOWED.test(segment) ||
        WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment)) {
      throw new Error(`Недопустимый путь: ${relative}`);
    }
  }
  return segments;
}

function selectRoot(action, roots) {
  if (!Array.isArray(roots) || !roots.length) {
    throw new Error('Откройте папку проекта в VS Code.');
  }
  if (roots.length === 1) {
    if (action.root !== undefined && action.root !== roots[0].name) {
      throw new Error(`Неизвестный корень: ${action.root}`);
    }
    return roots[0];
  }

  const matches = roots.filter(item => item.name === action.root);
  if (matches.length !== 1) {
    throw new Error('Для нескольких корней workspace необходимо поле root с уникальным именем папки.');
  }
  return matches[0];
}

async function inspectPath(rootPath, segments) {
  const canonicalRoot = await fs.realpath(rootPath);
  let current = canonicalRoot;

  // Не разрешаем переходить через symlink, в том числе внутри пути к новому файлу.
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { absolute: path.join(canonicalRoot, ...segments), exists: false };
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Символические ссылки в пути запрещены: ${segments.join('/')}`);
    }
    if (i < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Часть пути не является папкой: ${segments.join('/')}`);
    }
    if (i === segments.length - 1) {
      if (!stat.isFile()) throw new Error(`Не обычный файл: ${segments.join('/')}`);
      return { absolute: current, exists: true, stat };
    }
  }
  throw new Error('Пустой путь.');
}

function decodeUtf8(buffer, display) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`Файл больше 1 МиБ: ${display}`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(`Файл не является текстом UTF-8: ${display}`);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  relativeSegments,
  selectRoot,
  inspectPath,
  decodeUtf8
};

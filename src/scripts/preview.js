'use strict';

const crypto = require('node:crypto');
const { LANGUAGES } = require('./request');

const PREVIEW_SCHEME = 'aibolit-preview';

// The preview metadata describes the exact execution but is NOT included in the
// script that is persisted or executed. Supported interpreters accept # comments.
function formatScriptPreview(script, { args = [], cwd = '' } = {}) {
  if (!LANGUAGES[script.language] || typeof script.content !== 'string') {
    throw new Error('Неизвестный формат предпросмотра скрипта.');
  }
  return [
    '# === AIBOLIT: READ-ONLY PREVIEW ===',
    '# Следующие строки — сведения о запуске; они НЕ исполняются.',
    '# Script ID: ' + script.id,
    '# Language: ' + script.language,
    '# Script SHA-256: ' + script.hash,
    '# Working directory: ' + JSON.stringify(cwd),
    '# Arguments (JSON): ' + JSON.stringify(args),
    '# === ИСПОЛНЯЕМЫЙ КОД НАЧИНАЕТСЯ ПОСЛЕ ЭТОЙ СТРОКИ ===',
    ''
  ].join('\n') + '\n' + script.content;
}

function registerScriptPreview(vscode, context) {
  const documents = new Map();
  const readonly = () => { throw vscode.FileSystemError.NoPermissions('Aibolit: предпросмотр только для чтения.'); };
  const missing = () => { throw vscode.FileSystemError.FileNotFound('Aibolit: предпросмотр больше недоступен.'); };
  const key = uri => uri.toString();
  const root = uri => uri.path === '/' || uri.path === '';
  const lookup = uri => {
    const entry = documents.get(key(uri));
    if (!entry) return missing();
    return entry;
  };

  // A filesystem registered as isReadonly is explicitly locked by VS Code,
  // unlike a plain untitled buffer or a document shown with just a heading.
  const provider = {
    onDidChangeFile: () => ({ dispose() {} }),
    watch: () => ({ dispose() {} }),
    stat(uri) {
      if (root(uri)) return {
        type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0,
        permissions: vscode.FilePermission.Readonly
      };
      const entry = lookup(uri);
      return {
        type: vscode.FileType.File, ctime: entry.created, mtime: entry.created,
        size: entry.bytes.length, permissions: vscode.FilePermission.Readonly
      };
    },
    readDirectory(uri) {
      if (!root(uri)) return missing();
      return [...documents.values()].map(entry => [entry.name, vscode.FileType.File]);
    },
    createDirectory: readonly,
    readFile(uri) { return Buffer.from(lookup(uri).bytes); },
    writeFile: readonly,
    delete: readonly,
    rename: readonly
  };
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(PREVIEW_SCHEME, provider, {
    isReadonly: true,
    isCaseSensitive: true
  }));
  if (typeof vscode.workspace.onDidCloseTextDocument === 'function') {
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === PREVIEW_SCHEME) documents.delete(key(document.uri));
    }));
  }

  return async function showScriptPreview(script, options = {}) {
    if (!LANGUAGES[script.language]) throw new Error('Неизвестный язык скрипта.');
    const contextHash = crypto.createHash('sha256')
      .update(script.hash + '\0' + String(options.cwd || '') + '\0' + JSON.stringify(options.args || []))
      .digest('hex').slice(0, 12);
    const name = `${script.id}-${script.hash.slice(0, 12)}-${contextHash}${LANGUAGES[script.language]}`;
    const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/${name}`);
    const bytes = Buffer.from(formatScriptPreview(script, options), 'utf8');
    documents.set(key(uri), { name, bytes, created: Date.now() });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  };
}

module.exports = { PREVIEW_SCHEME, formatScriptPreview, registerScriptPreview };

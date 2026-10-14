'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

test('VS Code commands: copy base, edit custom, copy merged, edit base', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-command-test-'));
  const handlers = new Map();
  const shown = [];
  const notices = [];
  let clipboardText = '';
  let selectedType = 'custom';
  const mockVscode = {
    commands: { registerCommand(name, handler) { handlers.set(name, handler); return { dispose() {} }; } },
    env: { clipboard: { async writeText(text) { clipboardText = text; }, async readText() { return clipboardText; } } },
    Uri: { file(fsPath) { return { fsPath }; } },
    workspace: { registerFileSystemProvider() { return { dispose() {} }; }, async openTextDocument(uri) { return { uri }; } },
    window: {
      async showTextDocument(doc) { shown.push(doc.uri.fsPath); },
      async showQuickPick(items) { return items.find(item => item.type === selectedType); },
      showErrorMessage(msg) { throw new Error(msg); },
      showInformationMessage(msg) { notices.push(msg); }
    }
  };
  const originalLoad = Module._load;
  const engineLocation = require.resolve('../src/engine');
  const existingEngine = require.cache[engineLocation];
  const extensionLocation = require.resolve('../extension');
  const existingExtension = require.cache[extensionLocation];
  try {
    // This test exercises instruction commands independently of optional native VS Code runtime
    // and of the diff dependency used by the unchanged file-action engine.
    require.cache[engineLocation] = {
      id: engineLocation, filename: engineLocation, loaded: true,
      exports: { prepare() {}, commit() {} }
    };
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') return mockVscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[extensionLocation];
    const extension = require('../extension');
    extension.activate({
      globalStorageUri: { fsPath: storage },
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: []
    });
    await handlers.get('aibolit.copyInstructions')();
    assert.match(clipboardText, /# Aibolit — правила взаимодействия с ИИ/);
    assert.match(clipboardText, /createFile/);
    await handlers.get('aibolit.editInstructions')();
    assert.equal(shown.at(-1), path.join(storage, 'custom.md'));
    await fs.writeFile(shown.at(-1), 'Всегда используй русский язык.\n');
    await handlers.get('aibolit.copyInstructions')();
    assert.match(clipboardText, /Всегда используй русский язык/);
    selectedType = 'base';
    await handlers.get('aibolit.editInstructions')();
    assert.equal(shown.at(-1), path.join(storage, 'protocol.md'));
    assert.equal(notices.length, 2);
  } finally {
    Module._load = originalLoad;
    if (existingEngine) require.cache[engineLocation] = existingEngine;
    else delete require.cache[engineLocation];
    if (existingExtension) require.cache[extensionLocation] = existingExtension;
    else delete require.cache[extensionLocation];
    await fs.rm(storage, { recursive: true, force: true });
  }
});

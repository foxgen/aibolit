'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('VS Code Apply context executes script, copies result and clears only runs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-extension-scripts-'));
  const project = path.join(temp, 'project');
  const storage = path.join(temp, 'workspace');
  await fs.mkdir(project);
  const handlers = new Map();
  const info = [], errors = [];
  const request = { version: 1, kind: 'script', requestId: 'explore-1', commands: [
    { id: 'tree', script: { id: 'test-tree', language: 'python', content: 'print("hello-vscode")\n' } }
  ] };
  let clipboard = JSON.stringify(request);
  let prompts = 0;
  let choice = 'last';
  const vscode = {
    commands: { registerCommand(id, fn) { handlers.set(id, fn); return { dispose() {} }; } },
    env: { clipboard: { async readText() { return clipboard; }, async writeText(value) { clipboard = value; } } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: project } }],
      textDocuments: [],
      registerFileSystemProvider() { return { dispose() {} }; },
      getConfiguration() { return { get(key, defaultValue) { return defaultValue; } }; }
    },
    window: {
      activeTextEditor: null,
      async showWarningMessage(message, options) {
        prompts++;
        return message.includes('уже выполнялся') ? 'Copy saved result' :
          message.includes('Удалить') ? 'Delete outputs' : 'Approve and run';
      },
      async showQuickPick(items) {
        if (items.some(x => x.action)) return items.find(x => x.action === choice);
        return choice === 'select' ? items : undefined;
      },
      showInformationMessage(message) { info.push(message); },
      showErrorMessage(message) { errors.push(message); }
    }
  };
  const originalLoad = Module._load;
  const extensionFile = require.resolve('../extension');
  const engineFile = require.resolve('../src/engine');
  const extensionCached = require.cache[extensionFile];
  const engineCached = require.cache[engineFile];
  try {
    require.cache[engineFile] = { id: engineFile, filename: engineFile, loaded: true, exports: { prepare() {}, commit() {} } };
    Module._load = function (request, parent, main) {
      if (request === 'vscode') return vscode;
      return originalLoad.call(this, request, parent, main);
    };
    delete require.cache[extensionFile];
    require('../extension').activate({ storageUri: { scheme: 'file', fsPath: storage },
      globalStorageUri: { fsPath: path.join(temp, 'global') }, extensionPath: path.join(__dirname, '..'), subscriptions: [] });
    await handlers.get('aibolit.executeClipboardActions')();
    assert.deepEqual(errors, []);
    const first = JSON.parse(clipboard);
    assert.equal(first.version, 1);
    assert.equal(first.kind, 'result');
    assert.equal(first.status, 'success');
    assert.match(first.commands[0].stdout, /hello-vscode/);
    const scriptEntries = await fs.readdir(path.join(storage, 'scripts'));
    assert.ok(scriptEntries.includes('test-tree'));

    clipboard = JSON.stringify(request);
    await handlers.get('aibolit.executeClipboardActions')();
    assert.equal(JSON.parse(clipboard).executionId, first.executionId);
    assert.equal((await fs.readdir(path.join(storage, 'runs'))).length, 1);
    choice = 'last';
    await handlers.get('aibolit.copyOutput')();
    assert.equal(JSON.parse(clipboard).executionId, first.executionId);

    // Multiple saved runs produce a protocol-1 `results` envelope.
    const nextRequest = { version: 1, kind: 'script', requestId: 'explore-2',
      commands: [{ id: 'again', scriptId: 'test-tree' }] };
    clipboard = JSON.stringify(nextRequest);
    await handlers.get('aibolit.executeClipboardActions')();
    assert.equal(JSON.parse(clipboard).version, 1);
    choice = 'select';
    await handlers.get('aibolit.copyOutput')();
    const many = JSON.parse(clipboard);
    assert.equal(many.version, 1);
    assert.equal(many.kind, 'results');
    assert.equal(many.executions.length, 2);
    assert.ok(many.executions.every(result => result.version === 1 && result.kind === 'result'));

    choice = 'all';
    await handlers.get('aibolit.deleteOutputs')();
    assert.deepEqual(await fs.readdir(path.join(storage, 'runs')), []);
    assert.ok((await fs.readdir(path.join(storage, 'scripts'))).includes('test-tree'));
    assert.ok(prompts >= 3);
  } finally {
    Module._load = originalLoad;
    if (engineCached) require.cache[engineFile] = engineCached; else delete require.cache[engineFile];
    if (extensionCached) require.cache[extensionFile] = extensionCached; else delete require.cache[extensionFile];
    await fs.rm(temp, { recursive: true, force: true });
  }
});

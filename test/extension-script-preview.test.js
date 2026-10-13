'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('preview can be reviewed without modal blocking; denial stops and does not store next script', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-preview-integration-'));
  const project = path.join(temp, 'project');
  const storage = path.join(temp, 'workspace');
  await fs.mkdir(project);
  const handlers = new Map(), messages = [], documents = [], notifications = [];
  let previewProvider;
  let clipboard = JSON.stringify({
    version: 3, kind: 'script', requestId: 'preview-001',
    commands: [
      { id: 'one', args: ['--example'], script: { id: 'first-new', language: 'python', content: 'print("first")\n' } },
      { id: 'two', script: { id: 'second-new', language: 'python', content: 'print("second")\n' } },
      { id: 'three', script: { id: 'third-new', language: 'python', content: 'print("third")\n' } }
    ]
  });
  const decisions = ['View script', 'Approve and run', 'View script', 'Cancel'];
  const vscode = {
    Uri: { parse(value) { const [scheme, uriPath] = value.split(':');
      return { scheme, path: uriPath, toString() { return value; } }; } },
    commands: { registerCommand(id, fn) { handlers.set(id, fn); return { dispose() {} }; } },
    env: { clipboard: { async readText() { return clipboard; }, async writeText(text) { clipboard = text; } } },
    FileType: { File: 1, Directory: 2 },
    FilePermission: { Readonly: 1 },
    FileSystemError: { NoPermissions: () => new Error('NoPermissions'), FileNotFound: () => new Error('FileNotFound') },
    workspace: {
      isTrusted: true, workspaceFolders: [{ name: 'project', uri: { scheme: 'file', fsPath: project } }],
      textDocuments: [],
      registerFileSystemProvider(scheme, provider, options) {
        assert.equal(scheme, 'aibolit-preview');
        assert.equal(options.isReadonly, true);
        previewProvider = provider; return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; },
      getConfiguration() { return { get(key, value) { return value; } }; },
      async openTextDocument(uri) {
        assert.equal(uri.scheme, 'aibolit-preview');
        const document = { uri, body: previewProvider.readFile(uri).toString('utf8'), isUntitled: false };
        documents.push(document);
        return document;
      }
    },
    window: {
      async showWarningMessage(message, options) {
        messages.push({ message, options });
        return decisions.shift();
      },
      async showTextDocument(document) {
        assert.equal(document.uri.scheme, 'aibolit-preview');
        notifications.push(document);
      },
      showInformationMessage() {},
      showErrorMessage(message) { throw new Error('Unexpected error: ' + message); }
    }
  };
  const originalLoad = Module._load;
  const extensionFile = require.resolve('../extension');
  const engineFile = require.resolve('../src/engine');
  const originalExtension = require.cache[extensionFile];
  const originalEngine = require.cache[engineFile];
  try {
    require.cache[engineFile] = { id: engineFile, filename: engineFile, loaded: true,
      exports: { prepare() {}, commit() {} } };
    Module._load = function (id, parent, main) {
      if (id === 'vscode') return vscode;
      return originalLoad.call(this, id, parent, main);
    };
    delete require.cache[extensionFile];
    require('../extension').activate({ storageUri: { scheme: 'file', fsPath: storage },
      globalStorageUri: { fsPath: path.join(temp, 'global') }, extensionPath: path.join(__dirname, '..'), subscriptions: [] });
    await handlers.get('aibolit.executeClipboardActions')();
    const result = JSON.parse(clipboard);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.commands.map(cmd => cmd.status), ['success', 'denied', 'skipped']);
    assert.equal(messages.length, 4, 'two prompts per reached step, no prompt for skipped step');
    assert.deepEqual(messages.map(x => x.options.modal), [true, false, true, false]);
    assert.equal(notifications.length, 2);
    assert.equal(documents.length, 2);
    assert.ok(documents[0].body.includes(JSON.stringify(['--example'])));
    assert.ok(documents[0].body.includes(JSON.stringify(project)));
    assert.ok(documents[0].body.endsWith('\nprint("first")\n'));
    assert.ok(documents[1].body.endsWith('\nprint("second")\n'));
    assert.ok(documents.every(x => !x.isUntitled));
    const scripts = await fs.readdir(path.join(storage, 'scripts'));
    assert.ok(scripts.includes('first-new'));
    assert.ok(!scripts.includes('second-new'));
    assert.ok(!scripts.includes('third-new'));
    const approvals = JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'approvals.json'), 'utf8'));
    assert.deepEqual(Object.keys(approvals), ['first-new']);
  } finally {
    Module._load = originalLoad;
    if (originalEngine) require.cache[engineFile] = originalEngine; else delete require.cache[engineFile];
    if (originalExtension) require.cache[extensionFile] = originalExtension; else delete require.cache[extensionFile];
    await fs.rm(temp, { recursive: true, force: true });
  }
});

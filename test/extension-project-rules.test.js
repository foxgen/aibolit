'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('project selection, editing, copying and guarded reset work through VS Code commands', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-extension-project-'));
  const storage = path.join(temp, 'storage');
  const projectA = path.join(temp, 'app-a');
  const projectB = path.join(temp, 'app-b');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);

  const handlers = new Map();
  const notices = [];
  const errors = [];
  const opened = [];
  const openDocuments = [];
  let copied = '';
  let selectedType = 'project';
  let selectedRoot = projectA;
  let confirm = 'Reset instructions';
  const mock = {
    commands: { registerCommand(id, action) { handlers.set(id, action); return { dispose() {} }; } },
    env: { clipboard: { async writeText(text) { copied = text; } } },
    Uri: { file(fsPath) { return { scheme: 'file', fsPath }; } },
    workspace: {
      workspaceFolders: [
        { name: 'app-a', uri: { scheme: 'file', fsPath: projectA } },
        { name: 'app-b', uri: { scheme: 'file', fsPath: projectB } }
      ],
      textDocuments: openDocuments,
      registerFileSystemProvider() { return { dispose() {} }; },
      async openTextDocument(uri) { return { uri, isDirty: false }; }
    },
    window: {
      async showQuickPick(items) {
        if (items.some(item => item.root)) return items.find(item => item.root === selectedRoot);
        return items.find(item => item.type === selectedType);
      },
      async showTextDocument(doc) { opened.push(doc.uri.fsPath); },
      async showWarningMessage(message, options, action) {
        assert.equal(options.modal, true);
        assert.equal(action, 'Reset instructions');
        return confirm;
      },
      showErrorMessage(message) { errors.push(message); },
      showInformationMessage(message) { notices.push(message); }
    }
  };
  const originalLoad = Module._load;
  const extensionFile = require.resolve('../extension');
  const engineFile = require.resolve('../src/engine');
  const oldExtension = require.cache[extensionFile];
  const oldEngine = require.cache[engineFile];
  try {
    require.cache[engineFile] = { id: engineFile, filename: engineFile, loaded: true, exports: { prepare() {}, commit() {} } };
    Module._load = function mockedLoad(request, parent, isMain) {
      if (request === 'vscode') return mock;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[extensionFile];
    require('../extension').activate({
      globalStorageUri: { fsPath: storage },
      extensionPath: path.join(__dirname, '..'),
      subscriptions: []
    });
    await handlers.get('aibolit.editInstructions')();
    const projectAFile = path.join(projectA, '.aibolit', 'instructions.md');
    assert.equal(opened.at(-1), projectAFile);
    await fs.writeFile(projectAFile, 'RULES A\n');
    await handlers.get('aibolit.copyInstructions')();
    assert.match(copied, /RULES A/);

    selectedRoot = projectB;
    await handlers.get('aibolit.copyInstructions')();
    assert.doesNotMatch(copied, /RULES A/);
    await handlers.get('aibolit.editProjectInstructions')();
    const projectBFile = path.join(projectB, '.aibolit', 'instructions.md');
    await fs.writeFile(projectBFile, 'RULES B\n');
    await handlers.get('aibolit.copyInstructions')();
    assert.match(copied, /RULES B/);
    assert.doesNotMatch(copied, /RULES A/);

    // Dirty documents are never reset.
    openDocuments.push({ uri: { scheme: 'file', fsPath: projectBFile }, isDirty: true });
    selectedType = 'project';
    await handlers.get('aibolit.resetInstructions')();
    assert.match(errors.at(-1), /несохранённые изменения/);
    assert.equal(await fs.readFile(projectBFile, 'utf8'), 'RULES B\n');
    openDocuments.length = 0;

    confirm = undefined;
    await handlers.get('aibolit.resetInstructions')();
    assert.equal(await fs.readFile(projectBFile, 'utf8'), 'RULES B\n');
    confirm = 'Reset instructions';
    await handlers.get('aibolit.resetInstructions')();
    await assert.rejects(fs.access(projectBFile), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.dirname(projectBFile)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(projectAFile, 'utf8'), 'RULES A\n');
    assert.match(notices.at(-1), /Резервная копия:/);
    const backupPath = notices.at(-1).split('Резервная копия: ')[1];
    assert.equal(await fs.readFile(backupPath, 'utf8'), 'RULES B\n');

    // Repeating Reset does not recreate the project file or claim a backup.
    const noticesBefore = notices.length;
    await handlers.get('aibolit.resetInstructions')();
    assert.equal(notices.length, noticesBefore + 1);
    assert.match(notices.at(-1), /проектных инструкций уже нет/);
    await assert.rejects(fs.access(path.dirname(projectBFile)), { code: 'ENOENT' });
  } finally {
    Module._load = originalLoad;
    if (oldEngine) require.cache[engineFile] = oldEngine;
    else delete require.cache[engineFile];
    if (oldExtension) require.cache[extensionFile] = oldExtension;
    else delete require.cache[extensionFile];
    await fs.rm(temp, { recursive: true, force: true });
  }
});

'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ensureInstructions, ensureProjectInstructions, combinedInstructions, resetInstructions, instructionPaths, projectInstructionsPath } = require('./src/instructions');
const { parseContext, PROTOCOL_VERSION } = require('./src/protocol');
const { prepare, commit } = require('./src/engine');
const { prepareExecution, executeScripts } = require('./src/scripts/execution');
const { registerScriptPreview } = require('./src/scripts/preview');
const { listOutputEntries, toAIResult, clearOutputs, clearAllOutputs } = require('./src/scripts/outputs');

let applying = false;

async function copyFileContents(uri, selectedUris) {
  const uris = Array.isArray(selectedUris) && selectedUris.length
    ? selectedUris
    : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
  if (!uris.length) {
    vscode.window.showWarningMessage('Aibolit: выберите файлы или откройте файл в редакторе.');
    return;
  }

  const collected = [];
  let skipped = 0;
  for (const item of uris) {
    if (item.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(item)) { skipped++; continue; }
    try {
      if (!(await fs.stat(item.fsPath)).isFile()) { skipped++; continue; }
      const name = vscode.workspace.asRelativePath(item, (vscode.workspace.workspaceFolders || []).length > 1)
        .replace(/\\/g, '/');
      // Reflect unsaved changes from the active document, when it is already open.
      const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === item.toString());
      const content = openDoc ? openDoc.getText() : await fs.readFile(item.fsPath, 'utf8');
      collected.push(`---- BEGIN FILE: ${name} ----\n${content}\n---- END FILE: ${name} ----`);
    } catch { skipped++; }
  }
  if (!collected.length) {
    vscode.window.showWarningMessage('Aibolit: не найдено подходящих файлов внутри проекта.');
    return;
  }
  await vscode.env.clipboard.writeText(collected.join('\n\n') + '\n');
  vscode.window.showInformationMessage(`Aibolit: скопировано ${collected.length}, пропущено ${skipped}.`);
}

async function applyAIContext() {
  if (applying) {
    vscode.window.showWarningMessage('Aibolit: предыдущий контекст ещё применяется.');
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showErrorMessage('Aibolit: требуется доверенная папка VS Code (Workspace Trust).');
    return;
  }
  applying = true;
  try {
    const payload = parseContext(await vscode.env.clipboard.readText());
    const roots = (vscode.workspace.workspaceFolders || []).map(folder => ({
      name: folder.name, path: folder.uri.fsPath, scheme: folder.uri.scheme
    }));
    if (roots.some(root => root.scheme !== 'file')) {
      throw new Error('В этой версии поддерживаются только локальные папки проекта.');
    }
    if (payload.kind === 'script') {
      await applyScriptContext(payload, roots);
      return;
    }
    const plan = await prepare(payload.actions, roots);
    const checkDirty = async changes => {
      const dirty = vscode.workspace.textDocuments.filter(doc => doc.isDirty &&
        changes.some(item => item.path.toLowerCase() === doc.uri.fsPath.toLowerCase()));
      if (dirty.length) {
        throw new Error(`Сначала сохраните несохранённые изменения: ${dirty.map(doc => doc.uri.fsPath).join(', ')}`);
      }
    };
    const result = await commit(plan, { checkDirty });
    vscode.window.showInformationMessage(
      `Aibolit: AI Context применён целиком. Создано файлов: ${result.created}, изменено: ${result.modified}.`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: ${error.message}`);
  } finally {
    applying = false;
  }
}


let currentContext;
let showScriptPreview;

function executionStorage() {
  const storage = currentContext?.storageUri;
  if (!storage || storage.scheme !== 'file') {
    throw new Error('Откройте локальный workspace: для истории запусков нужно workspaceStorage VS Code.');
  }
  return storage.fsPath;
}

async function authorizeScript(script, { args = [], cwd = '' } = {}) {
  // Consent is bound to the exact source, workspace root and arguments.
  const summary = `Aibolit: выполнить ${script.language} скрипт ${script.id} (${script.hash.slice(0, 12)})? ` +
    `Каталог: ${cwd}. Аргументы: ${JSON.stringify(args)}. ` +
    'Скрипт может менять любые доступные файлы и обращаться к сети.';
  let previewOpened = false;
  for (;;) {
    // The first prompt is modal. After opening the preview it MUST be nonmodal:
    // otherwise the user cannot scroll and inspect the code before deciding.
    const choice = await vscode.window.showWarningMessage(
      previewOpened ? 'Aibolit: изучите открытый код и параметры запуска. Затем подтвердите или отмените запуск. ' + summary : summary,
      { modal: !previewOpened }, 'View script', 'Approve and run', 'Cancel');
    if (choice === 'Approve and run') return true;
    if (choice !== 'View script') return false;
    await showScriptPreview(script, { args, cwd });
    previewOpened = true;
  }
}

async function applyScriptContext(payload, roots) {
  const storage = executionStorage();
  const prepared = await prepareExecution(payload, roots, storage, authorizeScript);
  if (prepared.previous) {
    const choice = await vscode.window.showWarningMessage(
      `Запрос ${payload.requestId} уже выполнялся. Повторный запуск может изменить файлы.`,
      { modal: true }, 'Copy saved result', 'Run again');
    if (choice === 'Copy saved result') {
      await vscode.env.clipboard.writeText(await toAIResult(prepared.previous));
      vscode.window.showInformationMessage('Aibolit: прежний результат скопирован.');
      return;
    }
    if (choice !== 'Run again') return;
  }
  const config = vscode.workspace.getConfiguration?.('aibolit') || { get: () => undefined };
  const interpreterCommands = {
    python: config.get('scripts.pythonCommand', 'python'),
    bash: config.get('scripts.bashCommand', 'bash'),
    powershell: config.get('scripts.powershellCommand', 'pwsh')
  };
  const run = await executeScripts(prepared, storage, interpreterCommands);
  const output = await toAIResult(run);
  await vscode.env.clipboard.writeText(output);
  vscode.window.showInformationMessage(
    `Aibolit: ${run.result.executionId}, статус ${run.result.status}. Результат скопирован в буфер.`);
}

// Output operations live in separate commands so the context menu can group
// copying and deletion under Aibolit -> Output.
async function outputEntries() {
  const storage = executionStorage();
  const entries = await listOutputEntries(storage);
  if (!entries.length) {
    vscode.window.showInformationMessage('Aibolit: история выполнений пуста.');
    return null;
  }
  return { storage, entries };
}

async function chooseOutputEntries(entries) {
  return vscode.window.showQuickPick(entries.map(item => ({
    label: `${item.result.requestId} (${item.result.status})`,
    description: `${item.result.executionId} · ${item.result.startedAt}`,
    item
  })), { canPickMany: true, placeHolder: 'Выберите выполнения' });
}

async function copyOutput() {
  try {
    const available = await outputEntries();
    if (!available) return;
    const { entries } = available;
    const selected = await vscode.window.showQuickPick([
      { label: 'Copy last output', action: 'last' },
      { label: 'Select outputs...', action: 'select' }
    ], { placeHolder: 'Какие результаты скопировать?' });
    if (!selected) return;
    if (selected.action === 'last') {
      await vscode.env.clipboard.writeText(await toAIResult(entries[0]));
      vscode.window.showInformationMessage('Aibolit: последний output скопирован.');
      return;
    }

    const choices = await chooseOutputEntries(entries);
    if (!choices?.length) return;
    const outputs = [];
    for (const choice of choices) outputs.push(JSON.parse(await toAIResult(choice.item)));
    // Multiple results are still a single JSON object, limited to 64 KiB.
    const text = JSON.stringify({ version: PROTOCOL_VERSION, kind: 'results', executions: outputs }, null, 2);
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
      throw new Error('Объединённый output превышает 64 КиБ. Выберите меньше выполнений.');
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`Aibolit: скопировано выполнений: ${outputs.length}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: ${error.message}`);
  }
}

async function deleteOutputs() {
  try {
    const available = await outputEntries();
    if (!available) return;
    const { storage, entries } = available;
    const selected = await vscode.window.showQuickPick([
      { label: 'Delete selected outputs...', action: 'selected' },
      { label: 'Delete all outputs...', action: 'all' }
    ], { placeHolder: 'Какие результаты удалить? Скрипты останутся.' });
    if (!selected) return;

    const choices = selected.action === 'selected' ? await chooseOutputEntries(entries) : entries;
    if (!choices?.length) return;
    const count = choices.length;
    const confirmed = await vscode.window.showWarningMessage(
      `Удалить ${count} выполнений? Сохранённые скрипты не затрагиваются.`,
      { modal: true }, 'Delete outputs');
    if (confirmed !== 'Delete outputs') return;

    const deleted = selected.action === 'all'
      ? await clearAllOutputs(storage)
      : await clearOutputs(storage, choices.map(choice => choice.item.result.executionId));
    vscode.window.showInformationMessage(`Aibolit: удалено выполнений: ${deleted}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: ${error.message}`);
  }
}


function templatePath(context) {
  return path.join(context.extensionPath, 'prompts', 'protocol.md');
}

// In a multi-root workspace the user selects one project explicitly. Never
// silently merge unrelated project rules into a single AI conversation.
async function chooseProjectRoot({ required = false } = {}) {
  const folders = (vscode.workspace.workspaceFolders || [])
    .filter(folder => folder.uri.scheme === 'file');
  if (folders.length === 0) {
    if (required) throw new Error('Откройте локальную папку проекта для работы с Project instructions.');
    return null;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })),
    { placeHolder: 'Для какого проекта использовать инструкции?' }
  );
  return selected ? selected.root : undefined;
}

async function copyInstructions(context) {
  try {
    const projectRoot = await chooseProjectRoot();
    if (projectRoot === undefined) return; // User cancelled root selection.
    const content = await combinedInstructions(
      context.globalStorageUri.fsPath, templatePath(context), projectRoot
    );
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage('Aibolit: инструкции скопированы в буфер обмена.');
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: не удалось скопировать инструкции: ${error.message}`);
  }
}

async function editInstructionsFile(context, type) {
  try {
    let file;
    if (type === 'project') {
      const root = await chooseProjectRoot({ required: true });
      if (root === undefined) return;
      file = await ensureProjectInstructions(root);
    } else {
      file = (await ensureInstructions(context.globalStorageUri.fsPath, templatePath(context)))[type];
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: не удалось открыть инструкции: ${error.message}`);
  }
}

async function chooseInstructionsToEdit(context) {
  const selected = await vscode.window.showQuickPick([
    { label: 'Base instructions (protocol.md)', description: 'Базовый протокол Aibolit', type: 'base' },
    { label: 'Custom instructions (custom.md)', description: 'Общие пользовательские правила', type: 'custom' },
    { label: 'Project instructions (.aibolit/instructions.md)', description: 'Правила выбранного проекта', type: 'project' },
    { label: 'Reset instructions...', description: 'Восстановить базовые или очистить пользовательские правила', type: 'reset' }
  ], { placeHolder: 'Какие инструкции изменить?' });
  if (!selected) return;
  if (selected.type === 'reset') await chooseInstructionsToReset(context);
  else await editInstructionsFile(context, selected.type);
}

async function chooseInstructionsToReset(context) {
  const selected = await vscode.window.showQuickPick([
    { label: 'Base instructions', description: 'Восстановить протокол из установленной версии', type: 'base' },
    { label: 'Custom instructions', description: 'Очистить общие пользовательские правила', type: 'custom' },
    { label: 'Project instructions', description: 'Удалить файл правил выбранного проекта', type: 'project' }
  ], { placeHolder: 'Какие инструкции сбросить?' });
  if (selected) await resetInstructionsCommand(context, selected.type);
}

async function resetInstructionsCommand(context, type) {
  try {
    const root = type === 'project' ? await chooseProjectRoot({ required: true }) : null;
    if (root === undefined) return;

    // Do not discard unsaved edits in VS Code's open document buffer.
    const target = type === 'project'
      ? await projectInstructionsPath(root)
      : instructionPaths(context.globalStorageUri.fsPath)[type];
    const dirty = (vscode.workspace.textDocuments || []).some(doc =>
      doc.isDirty && doc.uri.scheme === 'file' &&
      path.normalize(doc.uri.fsPath).toLowerCase() === path.normalize(target).toLowerCase()
    );
    if (dirty) throw new Error('Сначала сохраните или отмените несохранённые изменения в файле инструкций.');

    const description = type === 'base'
      ? 'Базовые инструкции будут заменены шаблоном текущей версии Aibolit.'
      : type === 'custom'
        ? 'Общие пользовательские инструкции будут очищены.'
        : 'Файл инструкций выбранного проекта будет удалён. Если папка .aibolit пуста, она тоже будет удалена.';
    const confirmed = await vscode.window.showWarningMessage(
      `${description} Предыдущая версия сохранится в резервной копии. Продолжить?`,
      { modal: true }, 'Reset instructions'
    );
    if (confirmed !== 'Reset instructions') return;

    const result = await resetInstructions({
      type, storageDir: context.globalStorageUri.fsPath,
      templateFile: templatePath(context), projectRoot: root
    });
    if (result.unchanged) {
      vscode.window.showInformationMessage('Aibolit: проектных инструкций уже нет.');
    } else {
      vscode.window.showInformationMessage(`Aibolit: инструкции сброшены. Резервная копия: ${result.backup}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Aibolit: не удалось сбросить инструкции: ${error.message}`);
  }
}

function activate(context) {
  currentContext = context;
  showScriptPreview = registerScriptPreview(vscode, context);
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.copyFileContentsAI', copyFileContents),
    vscode.commands.registerCommand('aibolit.executeClipboardActions', applyAIContext),
    vscode.commands.registerCommand('aibolit.copyInstructions', () => copyInstructions(context)),
    vscode.commands.registerCommand('aibolit.copyOutput', copyOutput),
    vscode.commands.registerCommand('aibolit.deleteOutputs', deleteOutputs),
    vscode.commands.registerCommand('aibolit.editInstructions', () => chooseInstructionsToEdit(context)),
    vscode.commands.registerCommand('aibolit.editBaseInstructions', () => editInstructionsFile(context, 'base')),
    vscode.commands.registerCommand('aibolit.editCustomInstructions', () => editInstructionsFile(context, 'custom')),
    vscode.commands.registerCommand('aibolit.editProjectInstructions', () => editInstructionsFile(context, 'project')),
    vscode.commands.registerCommand('aibolit.resetInstructions', () => chooseInstructionsToReset(context))
  );
}

function deactivate() {}
module.exports = { activate, deactivate };

const vscode = require('vscode');
const fs = require('fs');

function activate(context) {
  const disposable = vscode.commands.registerCommand('extension.copyFileContentsAI', async (uri, selectedUris) => {
    const uris = selectedUris || (uri ? [uri] : []);
    if (uris.length === 0) {
      vscode.window.showWarningMessage('Файлы не выбраны');
      return;
    }

    let output = '';

    for (const fileUri of uris) {
      try {
        const content = fs.readFileSync(fileUri.fsPath, 'utf8');
        const fileName = fileUri.fsPath.split(/[/\\]/).pop();

        output += `---- BEGIN FILE: ${fileName} ----\n`;
        output += content + '\n';
        output += `---- END FILE: ${fileName} ----\n\n`;
      } catch (err) {
        output += `---- BEGIN FILE: ${fileUri.fsPath} ----\n[Ошибка чтения файла]\n---- END FILE: ${fileUri.fsPath} ----\n\n`;
      }
    }

    await vscode.env.clipboard.writeText(output);
    vscode.window.showInformationMessage('Содержимое файлов скопировано в AI-формате');
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
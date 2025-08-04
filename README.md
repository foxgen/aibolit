# Aibolit

**Aibolit** is a Visual Studio Code extension that helps you copy the content of selected files into a structured format, optimized for use in AI chat interfaces like ChatGPT or Claude.

## 🚀 Features

- Select one or more files in the **File Explorer**.
- Run a command to copy their contents in a clean, formatted style.
- Ideal for sending code to AI chats for review, refactoring, or debugging.

## 🧑‍💻 How to Use

1. Open the File Explorer in VS Code.
2. Select one or more files.
3. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac).
4. Run the command: `Aibolit: Copy Selected Files for AI`.
5. Paste the copied result into your AI chat window.

Each file will be formatted like this:

---- BEGIN FILE: path/to/file.js ----
<file content here>
---- END FILE: path/to/file.js ----

## 🧱 Build

To build the extension locally:
Install `vsce` if you haven’t already:

   ```bash
   npm install -g vsce
Install dependencies:

npm install
Package the extension:

vsce package
This will generate a .vsix file (e.g. aibolit-0.0.1.vsix).

To install the packaged extension manually:

code --install-extension aibolit-0.0.1.vsix
To uninstall it:

code --uninstall-extension your-publisher.aibolit

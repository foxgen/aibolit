'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shaScript } = require('../src/scripts/storage');
const { PREVIEW_SCHEME, formatScriptPreview, registerScriptPreview } = require('../src/scripts/preview');

function mockVSCode() {
  let provider, closed, options;
  const opened = [], visible = [];
  const readonly = () => new Error('NoPermissions');
  const vscode = {
    Uri: { parse(value) {
      const [scheme, uriPath] = value.split(':');
      return { scheme, path: uriPath, toString() { return value; } };
    } },
    FileType: { File: 1, Directory: 2 },
    FilePermission: { Readonly: 1 },
    FileSystemError: { NoPermissions: readonly, FileNotFound: () => new Error('FileNotFound') },
    workspace: {
      registerFileSystemProvider(scheme, handler, config) {
        assert.equal(scheme, PREVIEW_SCHEME);
        provider = handler; options = config;
        return { dispose() {} };
      },
      onDidCloseTextDocument(callback) { closed = callback; return { dispose() {} }; },
      async openTextDocument(uri) {
        assert.equal(uri.scheme, PREVIEW_SCHEME);
        const doc = { uri, text: provider.readFile(uri).toString('utf8'), isUntitled: false };
        opened.push(doc);
        return doc;
      }
    },
    window: { async showTextDocument(doc, config) { visible.push({ doc, config }); } }
  };
  return { vscode, opened, visible, close(doc) { closed(doc); },
    lookup(doc) { return provider.readFile(doc.uri).toString('utf8'); },
    get provider() { return provider; }, get options() { return options; } };
}

test('preview is an explicitly read-only filesystem (not only a label)', async () => {
  const env = mockVSCode();
  const subscriptions = [];
  const show = registerScriptPreview(env.vscode, { subscriptions });
  const script = { id: 'audit-python', language: 'python', content: 'print("hello")\n# script body\n' };
  script.hash = shaScript(script.language, script.content);
  const options = { cwd: 'C:\\Work\\project', args: ['alpha', 'a\nb', '--delete=no'] };
  const doc = await show(script, options);
  assert.equal(subscriptions.length, 2);
  assert.deepEqual(env.options, { isReadonly: true, isCaseSensitive: true });
  assert.equal(doc.uri.scheme, PREVIEW_SCHEME);
  assert.ok(doc.uri.path.endsWith('.py'));
  assert.deepEqual(env.visible[0].config, { preview: false });
  assert.equal(doc.isUntitled, false);
  assert.equal(env.provider.stat(doc.uri).type, env.vscode.FileType.File);
  assert.equal(env.provider.stat(doc.uri).permissions, env.vscode.FilePermission.Readonly);
  assert.equal(env.provider.stat(doc.uri).size, Buffer.byteLength(doc.text, 'utf8'));
  assert.ok(doc.text.includes(script.hash));
  assert.ok(doc.text.includes(JSON.stringify(options.cwd)));
  assert.ok(doc.text.includes(JSON.stringify(options.args)));
  assert.ok(doc.text.endsWith('\n' + script.content));
  const original = env.lookup(doc);
  for (const mutation of [
    () => env.provider.writeFile(doc.uri, Buffer.from('danger')),
    () => env.provider.delete(doc.uri),
    () => env.provider.rename(doc.uri, doc.uri),
    () => env.provider.createDirectory(doc.uri)
  ]) assert.throws(mutation, /NoPermissions/);
  assert.equal(env.lookup(doc), original, 'attempted writes cannot change approved preview');
  const doc2 = await show(script, { ...options, args: ['different'] });
  assert.notEqual(doc.uri.toString(), doc2.uri.toString());
  env.close(doc);
  assert.throws(() => env.lookup(doc), /FileNotFound/);
  assert.equal(env.lookup(doc2), doc2.text);
});

test('readonly filesystem exposes root and supported script previews', async () => {
  const env = mockVSCode();
  const show = registerScriptPreview(env.vscode, { subscriptions: [] });
  for (const [language, ext, code] of [
    ['bash', '.sh', 'printf "ready\\n"\n'],
    ['powershell', '.ps1', 'Write-Output "ready"\n']
  ]) {
    const script = { id: 'audit-' + language, language, content: code };
    script.hash = shaScript(language, code);
    const doc = await show(script, { cwd: 'C:\\Work', args: [] });
    assert.ok(doc.uri.path.endsWith(ext));
    assert.ok(doc.text.endsWith('\n' + code));
    assert.equal(env.provider.stat(doc.uri).permissions, env.vscode.FilePermission.Readonly);
  }
  const root = env.vscode.Uri.parse(PREVIEW_SCHEME + ':/');
  assert.equal(env.provider.stat(root).type, env.vscode.FileType.Directory);
  assert.equal(env.provider.readDirectory(root).length, 2);
});

test('preview formatter rejects unexpected languages and escapes newlines in metadata', () => {
  assert.throws(() => formatScriptPreview({ id: 'x', language: 'other', content: 'bad' }), /формат/);
  const preview = formatScriptPreview({ id: 'x', language: 'python', content: 'print(1)' },
    { args: ['\n# deceptive line'], cwd: 'C:\\Work' });
  assert.ok(preview.includes('\\n# deceptive line'));
  assert.ok(preview.endsWith('\nprint(1)'));
});

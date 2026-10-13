'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

const COPY = 'extension.copyFileContentsAI';
const APPLY = 'aibolit.executeClipboardActions';
const INSTRUCTIONS = 'aibolit.copyInstructions';
const OUTPUT = 'aibolit.copyOutput';
const DELETE = 'aibolit.deleteOutputs';
const EDIT = 'aibolit.editInstructions';

 test('contributes one Aibolit submenu to both context menus', () => {
  const { submenus, menus } = pkg.contributes;
  assert.deepEqual(submenus, [
    { id: 'aibolit.actionsMenu', label: 'Aibolit' },
    { id: 'aibolit.outputMenu', label: 'Output' }
  ]);
  for (const location of ['explorer/context', 'editor/context']) {
    assert.equal(menus[location].length, 1);
    assert.equal(menus[location][0].submenu, 'aibolit.actionsMenu');
    assert.equal(menus[location][0].command, undefined);
  }
  assert.deepEqual(menus['aibolit.actionsMenu'].map(i => i.command || i.submenu),
    [COPY, INSTRUCTIONS, APPLY, 'aibolit.outputMenu', EDIT]);
  assert.deepEqual(menus['aibolit.outputMenu'].map(i => i.command), [OUTPUT, DELETE]);
});

test('preserves extension identity and old command IDs; exposes editor commands', () => {
  const commands = Object.fromEntries(pkg.contributes.commands.map(c => [c.command, c]));
  assert.equal(commands[COPY].title, 'Copy code');
  assert.equal(commands[APPLY].title, 'Apply context');
  assert.equal(commands[INSTRUCTIONS].title, 'Copy instructions');
  assert.equal(commands[OUTPUT].title, 'Copy...');
  assert.equal(commands[DELETE].title, 'Delete...');
  assert.equal(commands[EDIT].title, 'Edit instructions...');
  assert.equal(commands['aibolit.editBaseInstructions'].title, 'Edit base instructions');
  assert.equal(commands['aibolit.editCustomInstructions'].title, 'Edit custom instructions');
  assert.ok(pkg.contributes.commands.every(c => c.category === 'Aibolit'));
  assert.equal(pkg.publisher, 'local-aibolit');
  assert.equal(pkg.name, 'aibolit');
});

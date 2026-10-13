'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { validateScriptRequest } = require('../src/scripts/request');
const { prepareExecution, executeScripts } = require('../src/scripts/execution');
const { listOutputEntries, toAIResult, clearOutputs } = require('../src/scripts/outputs');
const { usedStorageBytes } = require('../src/scripts/storage');

const roots = [{ name: 'project', path: '.' }];

function context(commands, requestId = 'req-1') {
  return { version: 3, kind: 'script', requestId, commands };
}
const makeScript = (id, content) => ({ id, script: { id, language: 'python', content } });

async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-script-test-'));
  const storage = path.join(dir, 'storage');
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  try { return await fn(storage, [{ name: 'project', path: project }]); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('validates script identifiers, limits and workspace root', () => {
  assert.throws(() => validateScriptRequest(context([makeScript('../evil', 'print(1)')]), roots), /id:/);
  assert.throws(() => validateScriptRequest(context([makeScript('hi', 'print(1)'), makeScript('hi', 'print(2)')]), roots), /уникальный id/);
  assert.throws(() => validateScriptRequest(context([makeScript('hi', 'print(1)')]), [...roots, { name: 'other', path: 'other' }]), /root/);
  assert.equal(validateScriptRequest(context([makeScript('ok', 'print(1)')]), roots).root.name, 'project');
});

test('executes sequential scripts, stops on error and copies structured result', async () => {
  await temporary(async (storage, projectRoots) => {
    const request = context([
      makeScript('tree', 'print("test output")\n'),
      makeScript('fail', 'import sys\nprint("bad", file=sys.stderr)\nsys.exit(2)\n'),
      makeScript('never', 'print("never")\n')
    ]);
    const approved = [];
    const prepared = await prepareExecution(request, projectRoots, storage, async script => {
      approved.push(script.id); return true;
    });
    assert.deepEqual(approved, [], 'preflight must not request approvals');
    const run = await executeScripts(prepared, storage);
    assert.deepEqual(approved, ['tree', 'fail'], 'do not prompt for the skipped third script');
    assert.equal(run.result.status, 'failed');
    assert.deepEqual(run.result.commands.map(x => x.status), ['success', 'failed', 'skipped']);
    assert.equal(run.result.commands[1].exitCode, 2);
    const ai = JSON.parse(await toAIResult(run));
    assert.match(ai.commands[0].stdout, /test output/);
    assert.match(ai.commands[1].stderr, /bad/);
    assert.equal(ai.requestId, 'req-1');
    assert.equal((await listOutputEntries(storage)).length, 1);
    assert.equal((await fs.readFile(path.join(run.dir, 'request.json'), 'utf8')).includes('req-1'), true);
    const scriptIndex = JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'index.json'), 'utf8'));
    const approvals = JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'approvals.json'), 'utf8'));
    assert.deepEqual(Object.keys(scriptIndex).sort(), ['fail', 'tree']);
    assert.deepEqual(Object.keys(approvals).sort(), ['fail', 'tree']);
    await assert.rejects(fs.stat(path.join(storage, 'scripts', 'never')), { code: 'ENOENT' });
    const indexBefore = await fs.readFile(path.join(storage, 'scripts', 'index.json'), 'utf8');
    assert.equal(await clearOutputs(storage, [run.result.executionId]), 1);
    assert.deepEqual(await listOutputEntries(storage), []);
    assert.equal(await fs.readFile(path.join(storage, 'scripts', 'index.json'), 'utf8'), indexBefore);
  });
});

test('reuses saved scripts and does not persist declined revisions', async () => {
  await temporary(async (storage, projectRoots) => {
    let prompts = 0;
    const first = await prepareExecution(context([makeScript('hello', 'print("hello")\n')]), projectRoots,
      storage, async () => { prompts++; return true; });
    await executeScripts(first, storage);
    const originalIndex = JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'index.json'), 'utf8'));
    const originalApprovals = JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'approvals.json'), 'utf8'));
    const second = await prepareExecution(context([{ id: 'repeat', scriptId: 'hello' }], 'req-2'), projectRoots,
      storage, async () => { prompts++; return true; });
    const repeated = await executeScripts(second, storage);
    assert.equal(repeated.result.status, 'success');
    assert.equal(prompts, 1, 'unchanged script needs no new approval');

    const declined = await prepareExecution(context([makeScript('hello', 'print("changed")\n')], 'req-3'),
      projectRoots, storage, async () => { prompts++; return false; });
    assert.equal(prompts, 1, 'denial is prompted only when execution reaches the step');
    const run = await executeScripts(declined, storage);
    assert.equal(run.result.status, 'failed');
    assert.equal(run.result.commands[0].status, 'denied');
    assert.equal(prompts, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'index.json'), 'utf8')), originalIndex);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(storage, 'scripts', 'approvals.json'), 'utf8')), originalApprovals);
  });
});

test('declining an initial script neither approves nor saves any script', async () => {
  await temporary(async (storage, projectRoots) => {
    const seen = [];
    const request = context([
      makeScript('first', 'print("first")\n'),
      makeScript('second', 'print("second")\n')
    ], 'declined-1');
    const prepared = await prepareExecution(request, projectRoots, storage, async script => {
      seen.push(script.id);
      return false;
    });
    const run = await executeScripts(prepared, storage);
    assert.deepEqual(seen, ['first']);
    assert.deepEqual(run.result.commands.map(x => x.status), ['denied', 'skipped']);
    assert.equal(run.result.commands[1].reason, 'previous_command_failed');
    const files = await fs.readdir(path.join(storage, 'scripts'));
    assert.equal(files.includes('index.json'), false);
    assert.equal(files.includes('approvals.json'), false);
    assert.equal((await listOutputEntries(storage)).length, 1, 'a diagnostic run is stored');
  });
});

test('same requestId keeps prior execution and detects changed request', async () => {
  await temporary(async (storage, projectRoots) => {
    const request = context([makeScript('hello', 'print(1)\n')]);
    const first = await prepareExecution(request, projectRoots, storage, async () => true);
    const run = await executeScripts(first, storage);
    const repeat = await prepareExecution(request, projectRoots, storage, async () => true);
    assert.equal(repeat.previous.result.executionId, run.result.executionId);
    await assert.rejects(prepareExecution(context([makeScript('hello', 'print(2)\n')]), projectRoots, storage, async () => true),
      /requestId уже использован/);
  });
});

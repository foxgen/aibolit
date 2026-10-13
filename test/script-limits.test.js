'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runScript } = require('../src/scripts/runner');
const { toAIResult } = require('../src/scripts/outputs');

async function temp(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibolit-limit-test-'));
  try { await run(dir); }
  finally { await fs.rm(dir, { force: true, recursive: true }); }
}

test('stops excessive output without filling disk', async () => {
  await temp(async dir => {
    const script = path.join(dir, 'huge.js');
    await fs.writeFile(script, 'process.stdout.write("x".repeat(1024 * 1024));');
    const result = await runScript({ script: { language: 'python', file: script }, executable: process.execPath,
      cwd: dir, outputDir: path.join(dir, 'output'), maxOutputBytes: 4096 });
    assert.equal(result.status, 'output_limit');
    assert.equal(result.truncated, true);
    assert.ok((await fs.stat(path.join(dir, 'output', 'stdout.log'))).size <= 4096);
  });
});

test('returns timeout for long-running processes', async () => {
  await temp(async dir => {
    const script = path.join(dir, 'slow.js');
    await fs.writeFile(script, 'setInterval(() => {}, 1000);');
    const result = await runScript({ script: { language: 'python', file: script }, executable: process.execPath,
      cwd: dir, outputDir: path.join(dir, 'output'), timeoutMs: 400 });
    assert.equal(result.status, 'timeout');
  });
});

test('converts large saved console output into bounded JSON', async () => {
  await temp(async dir => {
    const cmd = path.join(dir, 'commands', 'tree');
    await fs.mkdir(cmd, { recursive: true });
    await fs.writeFile(path.join(cmd, 'stdout.log'), 'header\n' + 'x'.repeat(130000) + '\nfinal error');
    await fs.writeFile(path.join(cmd, 'stderr.log'), '');
    const record = { dir, result: { requestId: 'inspect-1', executionId: 'exec-demo', status: 'success',
      commands: [{ id: 'tree', scriptId: 'project-tree', status: 'success', exitCode: 0, truncated: false }] } };
    const json = await toAIResult(record);
    assert.ok(Buffer.byteLength(json, 'utf8') <= 65536);
    const payload = JSON.parse(json);
    assert.equal(payload.commands[0].truncated, true);
    assert.match(payload.commands[0].stdout, /final error/);
  });
});

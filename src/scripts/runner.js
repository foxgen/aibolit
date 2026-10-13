'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_RUN_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const INTERPRETERS = {
  python: { executable: 'python', args: file => [file] },
  bash: { executable: 'bash', args: file => [file] },
  powershell: { executable: 'pwsh', args: file => ['-NoProfile', '-NonInteractive', '-File', file] }
};

async function runScript({ script, args = [], cwd, outputDir, maxOutputBytes = MAX_RUN_OUTPUT,
  timeoutMs = DEFAULT_TIMEOUT_MS, executable }) {
  const interpreter = INTERPRETERS[script.language];
  if (!interpreter) throw new Error(`Неизвестный интерпретатор: ${script.language}`);
  await require('node:fs/promises').mkdir(outputDir, { recursive: true });
  const stdoutFile = path.join(outputDir, 'stdout.log');
  const stderrFile = path.join(outputDir, 'stderr.log');
  const out = fs.createWriteStream(stdoutFile, { flags: 'wx' });
  const err = fs.createWriteStream(stderrFile, { flags: 'wx' });
  let bytes = 0;
  let statusOverride = null;
  let processError = null;
  let child;
  let timer;
  let ioError = null;
  const finished = stream => new Promise(resolve => {
    for (const event of ['finish', 'close', 'error']) stream.once(event, resolve);
  });
  const outFinished = finished(out);
  const errFinished = finished(err);
  const fileError = e => { ioError = e; statusOverride = 'io_error'; child?.kill(); };
  out.on('error', fileError); err.on('error', fileError);
  const started = Date.now();
  try {
    child = spawn(executable || interpreter.executable, [...interpreter.args(script.file), ...args], {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const done = new Promise(resolve => {
      child.on('error', error => { processError = error; });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const receive = (stream, target) => stream.on('data', chunk => {
      if (statusOverride) return;
      const remaining = maxOutputBytes - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) target.write(chunk.subarray(0, remaining));
        bytes += Math.max(0, remaining);
        statusOverride = 'output_limit';
        child.kill();
      } else {
        bytes += chunk.length;
        target.write(chunk);
      }
    });
    receive(child.stdout, out);
    receive(child.stderr, err);
    timer = setTimeout(() => {
      if (!statusOverride) { statusOverride = 'timeout'; child.kill(); }
    }, timeoutMs);
    const { code, signal } = await done;
    return {
      status: processError ? 'start_error' : statusOverride || (code === 0 ? 'success' : 'failed'),
      exitCode: Number.isInteger(code) ? code : null, signal: signal || null,
      error: processError?.message || ioError?.message || null, durationMs: Date.now() - started,
      outputBytes: bytes, truncated: statusOverride === 'output_limit',
      stdout: 'stdout.log', stderr: 'stderr.log'
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!out.destroyed) out.end(); if (!err.destroyed) err.end();
    await Promise.all([outFinished, errFinished]);
  }
}

module.exports = { runScript, MAX_RUN_OUTPUT, DEFAULT_TIMEOUT_MS, INTERPRETERS };

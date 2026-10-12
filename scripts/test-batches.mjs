#!/usr/bin/env node
/** Full Node suite: bounded independent processes, real close events, no forced test exit. */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTestExecution } from './test-staging.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allFiles = readdirSync(resolve(root, 'test')).filter(name => name.endsWith('.test.ts')).sort().map(name => `test/${name}`);
const groups = {
  foundation: file => file === 'test/config.test.ts',
  api: file => ['test/api.test.ts', 'test/runtime.test.ts'].includes(file),
  auth: file => basename(file).startsWith('auth'),
  db: file => basename(file).startsWith('db'),
};
const options = process.argv.slice(2);
const local = options.includes('--local');
const refresh = options.includes('--refresh-dependencies');
const args = options.filter(arg => arg !== '--local' && arg !== '--refresh-dependencies');
let selected;
if (args.length === 0) selected = allFiles;
else if (args.length === 2 && args[0] === '--group' && groups[args[1]]) selected = allFiles.filter(groups[args[1]]);
else if (args.every(arg => allFiles.includes(arg))) selected = [...new Set(args)].sort();
else throw new Error('Usage: node scripts/test-batches.mjs [--local] [--refresh-dependencies] [--group foundation|api|auth|db | test/example.test.ts ...]');
if (!selected.length) throw new Error('No test files selected');

const timeoutMs = 55_000;
const started = Date.now();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const logDirectory = resolve(root, 'test-output', `batches-${runId}`);
mkdirSync(logDirectory, { recursive: true });
const execution = await prepareTestExecution(root, { local, refresh });
const active = new Set();
let interrupted = null;
function signalChild(child, signal) {
  if (!child.pid) return;
  try {
    // A timed-out POSIX batch owns its descendants (Node test workers, workerd, Wrangler).
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error(`Unable to send ${signal}: ${error.message}`); }
}
const interrupt = signal => {
  interrupted = signal;
  process.exitCode = 1;
  for (const child of active) signalChild(child, 'SIGTERM');
};
const onInt = () => interrupt('SIGINT');
const onTerm = () => interrupt('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);

async function runBatch(file) {
  const logPath = resolve(logDirectory, `${basename(file, '.test.ts')}.log`);
  const fd = openSync(logPath, 'w');
  const batchStarted = Date.now();
  let output = '', timedOut = false, spawnError = null, escalation;
  const commandArgs = ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', file];
  writeSync(fd, `# Command: ${process.execPath} ${commandArgs.join(' ')}\n# Cwd: ${execution.root}\n# Watchdog: ${timeoutMs} ms (timeout is a failure)\n`);
  console.log(`START ${file}`);
  const child = spawn(process.execPath, commandArgs, {
    cwd: execution.root, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  active.add(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; writeSync(fd, chunk); });
  child.stderr.on('data', chunk => writeSync(fd, chunk));
  child.on('error', error => { spawnError = error.message; writeSync(fd, `\n# Spawn error: ${error.message}\n`); });
  // This timer never turns an unfinished test into a pass. Close is always awaited.
  const watchdog = setTimeout(() => {
    timedOut = true;
    writeSync(fd, `\n# FAIL: batch exceeded ${timeoutMs} ms; sending SIGTERM\n`);
    signalChild(child, 'SIGTERM');
    escalation = setTimeout(() => signalChild(child, 'SIGKILL'), 2_000);
  }, timeoutMs);
  const { code, signal } = await new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  clearTimeout(watchdog);
  clearTimeout(escalation);
  active.delete(child);
  const elapsedMs = Date.now() - batchStarted;
  const counts = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    counts[key] = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  const skippedTests = output.split('\n').filter(line => /\bok\b.*# SKIP\b/.test(line)).map(line => line.trim());
  const ok = !interrupted && !timedOut && !spawnError && code === 0 && signal === null && elapsedMs < 60_000 &&
    Object.values(counts).every(value => value !== null) && counts.fail === 0 && counts.cancelled === 0 &&
    counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo;
  const result = { file, ok, code, signal, timedOut, spawnError, elapsedMs, counts, skippedTests, logPath };
  writeSync(fd, `\n# Batch close: ${JSON.stringify({ code, signal, timedOut, elapsedMs, ok })}\n`);
  closeSync(fd);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}: ${counts.pass ?? '?'} passed, ${counts.skipped ?? '?'} skipped, ${(elapsedMs / 1000).toFixed(2)}s, exit=${code}, signal=${signal}`);
  return result;
}

const results = [];
// The schema CLI integration is close to the budget on mounted filesystems; isolate it.
const ordinary = selected.filter(file => file !== 'test/schema-ready.test.ts');
let next = 0;
async function worker() {
  while (!interrupted && next < ordinary.length) {
    const file = ordinary[next++];
    results.push(await runBatch(file));
  }
}
await Promise.all(Array.from({ length: Math.min(2, ordinary.length) }, worker));
if (!interrupted && selected.includes('test/schema-ready.test.ts')) results.push(await runBatch('test/schema-ready.test.ts'));
results.sort((a, b) => a.file.localeCompare(b.file));
const totals = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, results.reduce((sum, result) => sum + (result.counts[key] ?? 0), 0)]));
const ok = !interrupted && results.length === selected.length && results.every(result => result.ok);
const failedBatches = results.filter(result => !result.ok).length;
const missingBatches = selected.length - results.length;
const timedOutBatches = results.filter(result => result.timedOut).length;
const incompleteTapBatches = results.filter(result => Object.values(result.counts).some(count => count === null)).length;
const summary = { ok, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, timeoutMs, concurrency: 2,
  executionRoot: execution.root, staged: execution.staged, dependencyKey: execution.dependencyKey ?? null,
  interrupted, selectedFiles: selected, completedBatches: results.length, failedBatches, missingBatches, timedOutBatches, incompleteTapBatches, totals, batches: results };
const summaryPath = resolve(logDirectory, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`FULL RESULT: ${ok ? 'PASS' : 'FAIL'}; ${totals.tests} reported tests; ${totals.pass} passed; ${totals.fail} failed tests; ${totals.cancelled} cancelled; ${totals.skipped} skipped; ${totals.todo} todo; ${failedBatches} failed batches; ${missingBatches} missing batches; ${timedOutBatches} timed out; ${incompleteTapBatches} incomplete TAP; ${results.length}/${selected.length} batches closed; ${(summary.elapsedMs / 1000).toFixed(2)}s`);
console.log(`Logs: ${logDirectory}\nSummary: ${summaryPath}`);
process.removeListener('SIGINT', onInt);
process.removeListener('SIGTERM', onTerm);
await execution.cleanup();
if (!ok) process.exitCode = 1;

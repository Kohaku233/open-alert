import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, 'test-output');
const sources = {
  'scripts/css-cascade.mjs': readFileSync(path.join(root, 'scripts/css-cascade.mjs')),
  'scripts/css-duplicates.mjs': readFileSync(path.join(root, 'scripts/css-duplicates.mjs')),
};
let fixtureRoot: string;

before(() => {
  mkdirSync(outputRoot, { recursive: true });
  // Keeping fixtures below the repo lets the copied CLIs resolve PostCSS.
  fixtureRoot = mkdtempSync(path.join(outputRoot, 'css-duplicates-'));
});
after(() => {
  if (!fixtureRoot) return;
  assert.equal(path.dirname(path.resolve(fixtureRoot)), outputRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

type Group = { selector: string; context: string[]; property: string; owners: { file: string; layer: string; important: boolean }[] };

function makeFixture(css: Record<string, string>, baseline?: string) {
  const fixture = mkdtempSync(path.join(fixtureRoot, 'case-'));
  const inputs = new Map<string, Buffer>();
  const put = (name: string, bytes: Buffer) => {
    const file = path.join(fixture, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    inputs.set(file, bytes);
  };
  for (const [name, bytes] of Object.entries(sources)) put(name, bytes);
  for (const [name, contents] of Object.entries(css)) put(`web/${name}`, Buffer.from(contents));
  if (baseline !== undefined) put('docs/css-duplicates.json', Buffer.from(baseline));
  return { fixture, inputs };
}

function run(css: Record<string, string>, args: string[] = [], baseline?: string, tool = 'scripts/css-duplicates.mjs') {
  const { fixture, inputs } = makeFixture(css, baseline);
  const result = spawnSync(process.execPath, [path.join(fixture, tool), ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  for (const [file, bytes] of inputs) assert.deepEqual(readFileSync(file), bytes, `CLI must leave ${file} unchanged`);
  return result;
}

function inventory(css: Record<string, string>): Group[] {
  const result = run(css, ['--print']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, 1);
  return parsed.duplicates;
}

const baselineOf = (groups: Group[]) => `${JSON.stringify({ version: 1, duplicates: groups }, null, 2)}\n`;
const twoFiles = (a: string, b: string, layers = ['', '']) => ({
  'app.css': `@layer low, high;\n@import './a.css'${layers[0] ? ` layer(${layers[0]})` : ''};\n@import './b.css'${layers[1] ? ` layer(${layers[1]})` : ''};\n`,
  'a.css': a,
  'b.css': b,
});

for (const [argument, diagnostic] of [
  ['--write', '--write is unsupported'],
  ['--unknown', 'Unknown argument'],
] as const) {
  test(`rejects ${argument} without changing any fixture input`, () => {
    const result = run({ 'app.css': '.x { color: red; }\n' }, [argument], baselineOf([]));
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
  });
}

test('--print writes sorted LF JSON with a trailing newline', () => {
  const result = run(twoFiles('.b { color: red; }\n.a { margin: 0; }\n', '.a { margin: 1px; }\n.b { color: blue; }\n'), ['--print']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith('}\n'));
  assert.doesNotMatch(result.stdout, /\r/);
  const groups: Group[] = JSON.parse(result.stdout).duplicates;
  assert.deepEqual(groups.map(g => g.selector), ['.a', '.b']);
  assert.deepEqual(groups[0]?.owners, [
    { file: 'web/a.css', layer: '', important: false },
    { file: 'web/b.css', layer: '', important: false },
  ]);
});

test('reports the same property across files in one layer and across layers in one file', () => {
  assert.equal(inventory(twoFiles('.x { color: red; }\n', '.x { color: blue; }\n', ['low', 'low'])).length, 1);
  const groups = inventory({ 'app.css': '@layer low, high;\n@layer low {.x {color:red;}}\n@layer high {.x {color:blue;}}\n' });
  assert.deepEqual(groups[0]?.owners.map(o => o.layer), ['high', 'low']);
});

test('ignores repeats inside one owner, including separate rules', () => {
  assert.deepEqual(inventory({ 'app.css': '.x { color: red; color: blue; }\n.x { color: green; }\n' }), []);
});

test('ignores different properties on the same selector', () => {
  assert.deepEqual(inventory(twoFiles('.x { color: red; }\n', '.x { margin: 0; }\n')), []);
});

test('keys on the exact raw context stack', () => {
  const media = (q: string) => `@media ${q} { .x { color: red; } }\n`;
  assert.equal(inventory(twoFiles(media('(max-width: 600px)'), media('(max-width: 600px)'))).length, 1);
  assert.deepEqual(inventory(twoFiles(media('(max-width: 600px)'), media('(max-width:600px)'))), []);
  assert.deepEqual(inventory(twoFiles(media('(max-width: 600px)'), '.x { color: blue; }\n')), []);
  const groups = inventory(twoFiles('@supports (display: grid) { @media print { .x { color: red; } } }\n', '@supports (display: grid) { @media print { .x { color: blue; } } }\n'));
  assert.deepEqual(groups[0]?.context, ['supports (display: grid)', 'media print']);
});

test('keeps selector text exact and selector lists unsplit', () => {
  assert.deepEqual(inventory(twoFiles('.a, .b { color: red; }\n', '.a { color: blue; }\n')), []);
  assert.deepEqual(inventory(twoFiles('.a,.b { color: red; }\n', '.a, .b { color: blue; }\n')), []);
  assert.deepEqual(inventory(twoFiles('.a:hover { color: red; }\n', '.a:is(:hover) { color: blue; }\n')), []);
  assert.deepEqual(inventory(twoFiles('[data-x="a"] { color: red; }\n', "[data-x='a'] { color: blue; }\n")), []);
  assert.equal(inventory(twoFiles('  .a  { color: red; }\n', '.a { color: blue; }\n')).length, 1);
});

test('lowercases ordinary properties, keeps custom property case, and separates shorthands', () => {
  assert.equal(inventory(twoFiles('.x { COLOR: red; }\n', '.x { color: blue; }\n'))[0]?.property, 'color');
  assert.deepEqual(inventory(twoFiles('.x { --Gap: 1px; }\n', '.x { --gap: 2px; }\n')), []);
  assert.equal(inventory(twoFiles(':root { --gap: 1px; }\n', ':root { --gap: 2px; }\n'))[0]?.property, '--gap');
  assert.deepEqual(inventory(twoFiles('.x { margin: 0; }\n', '.x { margin-top: 1px; }\n')), []);
});

test('includes !important and css-cascade-ignore declarations and records importance per owner', () => {
  const groups = inventory(twoFiles(
    '.x { color: red; }\n.x { color: blue !important; }\n',
    '.x { /* css-cascade-ignore: fallback */ color: green; }\n',
  ));
  assert.deepEqual(groups[0]?.owners.map(o => o.important), [true, false]);
});

test('passes when every current owner is in the baseline', () => {
  const css = twoFiles('.x { color: red; }\n', '.x { color: blue; }\n');
  const result = run(css, [], baselineOf(inventory(css)));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^1 duplicate groups; 0 new; 0 stale\n$/);
});

test('fails on a new group', () => {
  const result = run(twoFiles('.x { color: red; }\n', '.x { color: blue; }\n'), [], baselineOf([]));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /new: \.x \{ color \} web\/a\.css\[-\], web\/b\.css\[-\]/);
  assert.match(result.stdout, /1 duplicate groups; 1 new; 0 stale/);
});

test('fails when a known group gains a third owner', () => {
  const before = twoFiles('.x { color: red; }\n', '.x { color: blue; }\n');
  const css = { ...before, 'app.css': `${before['app.css']}@import './c.css' layer(high);\n`, 'c.css': '.x { color: green; }\n' };
  const result = run(css, [], baselineOf(inventory(before)));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /new: \.x \{ color \} web\/c\.css\[high\]\n/);
});

test('lists stale groups and owners without failing', () => {
  const before = twoFiles('.x { color: red; }\n.y { margin: 0; }\n', '.x { color: blue; }\n.y { margin: 1px; }\n');
  const result = run(twoFiles('.x { color: red; }\n', '.x { color: blue; }\n'), [], baselineOf(inventory(before)));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stale: \.y \{ margin \}/);
  assert.match(result.stdout, /1 duplicate groups; 0 new; 1 stale \(remove stale entries from docs\/css-duplicates\.json\)/);
});

for (const [name, baseline, diagnostic] of [
  ['missing', undefined, /Unable to read docs\/css-duplicates\.json/],
  ['invalid JSON', '{', /Unable to read docs\/css-duplicates\.json/],
  ['wrong version', '{"version":2,"duplicates":[]}\n', /Malformed docs\/css-duplicates\.json/],
  ['owner without layer', '{"version":1,"duplicates":[{"selector":".x","context":[],"property":"color","owners":[{"file":"web/a.css"}]}]}\n', /Malformed/],
] as const) {
  test(`rejects a ${name} baseline`, () => {
    const result = run({ 'app.css': '.x { color: red; }\n' }, [], baseline);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
  });
}

test('rejects circular imports but allows repeated non-circular imports', () => {
  const circular = run({ 'app.css': "@import './a.css';\n", 'a.css': "@import './app.css';\n" }, ['--print']);
  assert.equal(circular.status, 1);
  assert.match(circular.stderr, /Circular @import at .*a\.css:1: '\.\/app\.css'/);
  const self = run({ 'app.css': "@import './app.css';\n" }, [], undefined, 'scripts/css-cascade.mjs');
  assert.equal(self.status, 1);
  assert.match(self.stderr, /Circular @import at .*app\.css:1/);
  const repeated = run({ 'app.css': "@layer low, high;\n@import './a.css' layer(low);\n@import './a.css' layer(high);\n", 'a.css': '.x { color: red; }\n' }, ['--print']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).duplicates[0]?.owners.map((o: { layer: string }) => o.layer), ['high', 'low']);
});

test('importing the cascade module has no output and isolates state between parses', () => {
  const { fixture } = makeFixture({ 'app.css': "@layer a;\n@import './b.css' layer(b);\n", 'b.css': '.x { color: red; }\n' });
  const moduleUrl = pathToFileURL(path.join(fixture, 'scripts/css-cascade.mjs')).href;
  const entry = path.join(fixture, 'web/app.css');
  const probe = `const m = await import(${JSON.stringify(moduleUrl)});
const first = await m.parseStyles(${JSON.stringify(entry)});
const second = await m.parseStyles(${JSON.stringify(entry)});
console.log(JSON.stringify([first, second].map(list => list.map(e => [e.layer, e.rank, e.order]))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: fixture, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  // Infinity serializes as null; equal output proves layer order and sequence restart.
  assert.equal(result.stdout, '[[["b",[1,null],0]],[["b",[1,null],0]]]\n');
});

test('the committed baseline is LF-only, newline-terminated and has no new duplicates', () => {
  const file = readFileSync(path.join(root, 'docs/css-duplicates.json'), 'utf8');
  assert.doesNotMatch(file, /\r/);
  assert.ok(file.endsWith('\n'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/css-duplicates.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, / 0 new; /);
});

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, 'test-output');
const toolSource = readFileSync(path.join(root, 'scripts/css-cascade.mjs'));
let fixtureRoot: string;

before(() => {
  mkdirSync(outputRoot, { recursive: true });
  // Keeping fixtures below the repo lets the unchanged CLI resolve PostCSS.
  fixtureRoot = mkdtempSync(path.join(outputRoot, 'css-cascade-'));
});
after(() => {
  if (!fixtureRoot) return;
  assert.equal(path.dirname(path.resolve(fixtureRoot)), outputRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function runFixture(files: Record<string, string>, args: string[] = []) {
  const fixture = mkdtempSync(path.join(fixtureRoot, 'case-'));
  mkdirSync(path.join(fixture, 'scripts'));
  mkdirSync(path.join(fixture, 'web'));
  const script = path.join(fixture, 'scripts/css-cascade.mjs');
  writeFileSync(script, toolSource);
  const inputs = new Map([[script, toolSource]]);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(fixture, 'web', name);
    mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(contents);
    writeFileSync(file, bytes);
    inputs.set(file, bytes);
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  for (const [file, bytes] of inputs) {
    assert.deepEqual(readFileSync(file), bytes, `CLI must leave ${file} unchanged`);
  }
  return result;
}

function expectCandidates(files: Record<string, string>, count: number) {
  const result = runFixture(files);
  assert.equal(result.status, count ? 1 : 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp(`(?:^|\\n)${count} possible overrides`));
  return result.stdout;
}

for (const [argument, diagnostic] of [
  ['--write', '--write is unsupported'],
  ['--unknown', 'Unknown argument'],
] as const) {
  test(`rejects ${argument} without changing any fixture input`, () => {
    const result = runFixture({ 'app.css': '.target { color: red; }\n.target { color: blue; }\n' }, [argument]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
  });
}

for (const params of [
  "'./dep.css' screen",
  "'./dep.css' supports(display: grid)",
  "'./dep.css' layer(base) screen",
  "url('./dep.css')",
]) {
  test(`rejects unsupported import parameters: ${params}`, () => {
    const result = runFixture({ 'app.css': `@import ${params};\n` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported local @import at .*app\.css:1:/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  });
}

for (const context of ['@media (min-width: 1px)', '@supports (display: grid)', '@layer base']) {
  for (const params of ["'./missing.css'", "'tailwindcss/theme.css' layer(theme)"]) {
    test(`rejects import inside ${context} before resolving ${params}`, () => {
      const result = runFixture({ 'app.css': `${context} {\n  @import ${params};\n}\n` });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unsupported local @import at .*app\.css:2:/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    });
  }
}

test('accepts supported top-level local and Tailwind imports', () => {
  expectCandidates({
    'app.css': "@layer theme, base, utilities;\n@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities);\n@import './plain.css';\n@import './layered.css' layer(base);\n",
    'plain.css': '.plain { color: red; }\n',
    'layered.css': '.layered { color: blue; }\n',
  }, 0);
});

test('preserves quoted selector text and descendant combinators', () => {
  expectCandidates({ 'app.css': `
[data-label="a  b"] { color: red; }
[data-label="a b"] { color: blue; }
[data-label="x > y"] { margin: 0; }
[data-label="x>y"] { margin: 1px; }
[data-label="x,y"] { padding: 0; }
[data-label="x, y"] { padding: 1px; }
[data-label="same"] { opacity: .4; }
[data-label='same'] { opacity: .8; }
.parent > .child { display: block; }
.parent .child { display: grid; }
` }, 0);
});

test('reports an exact cross-rule candidate with its source location', () => {
  const output = expectCandidates({ 'app.css': '.target { color: red; margin: 0; }\n.target { color: blue; }\n' }, 1);
  assert.match(output, /web\/app\.css:1 \.target \{ color \}/);
  assert.doesNotMatch(output, /\{ margin \}/);
});

test('does not split complete selector lists', () => {
  expectCandidates({ 'app.css': '.a, .b { color: red; }\n.a { color: blue; }\n' }, 0);
});

test('leaves same-rule repeated declarations outside the reported scope', () => {
  expectCandidates({ 'app.css': '.target { color: red; color: blue; }\n.fallback { display: block; display: grid; }\n' }, 0);
});

for (const [name, css, count] of [
  ['different media', '@media (max-width: 600px) {.x {color:red;}}\n@media (max-width: 400px) {.x {color:blue;}}', 0],
  ['identical media', '@media (max-width: 600px) {.x {color:red;}}\n@media (max-width: 600px) {.x {color:blue;}}', 1],
  ['different raw condition text', '@media (max-width:600px) {.x {color:red;}}\n@media (max-width: 600px) {.x {color:blue;}}', 0],
  ['later unconditional rule', '@media (max-width: 600px) {.x {color:red;}}\n.x {color:blue;}', 1],
  ['later conditional rule', '.x {color:red;}\n@media (max-width: 600px) {.x {color:blue;}}', 0],
  ['identical supports', '@supports (display: grid) {.x {color:red;}}\n@supports (display: grid) {.x {color:blue;}}', 1],
] as const) {
  test(`respects ${name} contexts`, () => {
    expectCandidates({ 'app.css': css }, count);
  });
}

test('declared layer order wins independently of import order', () => {
  const output = expectCandidates({
    'app.css': "@layer low, high;\n@import './high.css' layer(high);\n@import './low.css' layer(low);\n",
    'high.css': '.x { color: blue; }\n',
    'low.css': '.x { color: red; }\n',
  }, 1);
  assert.match(output, /web\/low\.css:1 \.x \{ color \}/);
});

test('later layers and unlayered declarations have the expected priority', () => {
  expectCandidates({ 'app.css': '@layer low, high;\n@layer low {.x {color:red;}}\n@layer high {.x {color:blue;}}' }, 1);
  expectCandidates({ 'app.css': '.x {color:blue;}\n@layer low {.x {color:red;}}' }, 1);
});

test('direct declarations outrank sublayers within the same layer', () => {
  const output = expectCandidates({ 'app.css': '@layer base {\n.x {color:blue;}\n@layer inner {.x {color:red;}}\n}' }, 1);
  assert.match(output, /web\/app\.css:3 \.x \{ color \}/);
});

test('excludes important declarations and custom properties', () => {
  expectCandidates({ 'app.css': '.x {color:red!important;--color:red;}\n.x {color:blue;--color:blue;}' }, 0);
});

test('an adjacent reason exempts a fallback but still lets it override an earlier rule', () => {
  const output = expectCandidates({ 'app.css': '.x {display:flex;}\n.x {/* css-cascade-ignore: older browser fallback */display:block;}\n.x {display:grid;}' }, 1);
  assert.match(output, /web\/app\.css:1 \.x \{ display \}/);
});

test('rejects an exemption without a reason', () => {
  const result = runFixture({ 'app.css': '.x {\n/* css-cascade-ignore: */\ndisplay:block;\n}\n.x {display:grid;}' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /css-cascade-ignore needs a reason at .*app\.css:2/);
});

test('a non-adjacent exemption does not suppress a candidate', () => {
  expectCandidates({ 'app.css': '.x {/* css-cascade-ignore: fallback */margin:0;display:block;}\n.x {display:grid;}' }, 1);
});

test('PostCSS is a direct dependency with a consistent lockfile entry', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.ok(pkg.devDependencies.postcss);
  assert.equal(pkg.devDependencies.postcss, lock.packages[''].devDependencies.postcss);
  assert.equal(pkg.devDependencies.postcss, lock.packages['node_modules/postcss'].version);
});

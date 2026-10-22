/**
 * Finds declarations that can never apply because a later cascade position sets
 * the same property for the same selector under the same (or no) at-rule.
 *
 *   node scripts/css-cascade.mjs          report and fail when any exist
 *   node scripts/css-cascade.mjs --write  remove them from web/*.css
 *
 * Only provable cases are handled: normal (non-!important) declarations, exact
 * selector matches after whitespace normalisation, and top-level style rules.
 */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

const root = path.resolve(import.meta.dirname, '..', 'web');
const entry = path.join(root, 'app.css');
const write = process.argv.includes('--write');

const norm = text => text.replace(/\s+/g, ' ').replace(/\s*([>+~,()])\s*/g, '$1').replace(/\(\s*/g, '(').trim();
const splitSelectors = text => {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(norm(text.slice(start, i))); start = i + 1; }
  }
  out.push(norm(text.slice(start)));
  return out;
};

// Layer tree: each node keeps child order; "direct" styles outrank sublayers.
const layerOrder = new Map();
const declareLayer = (parent, name) => {
  const key = parent ? `${parent}.${name}` : name;
  if (!layerOrder.has(key)) {
    const siblings = [...layerOrder.keys()].filter(k => (k.lastIndexOf('.') === -1 ? '' : k.slice(0, k.lastIndexOf('.'))) === (parent ?? ''));
    layerOrder.set(key, siblings.length);
  }
  return key;
};
// Rank tuple compared element-wise; Infinity marks direct (unlayered at that level) styles.
const rankOf = layer => {
  if (!layer) return [Infinity];
  const parts = layer.split('.'); const rank = [];
  for (let i = 0; i < parts.length; i++) rank.push(layerOrder.get(parts.slice(0, i + 1).join('.')));
  rank.push(Infinity);
  return rank;
};
const compareRank = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? Infinity, y = b[i] ?? Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

const files = new Map();
const entries = [];
let sequence = 0;

async function load(file, layer) {
  if (!files.has(file)) files.set(file, postcss.parse(await readFile(file, 'utf8'), {from: file}));
  await walk(files.get(file), file, layer, []);
}

async function walk(container, file, layer, context) {
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === 'atrule' && node.name === 'import') {
      const match = node.params.match(/^['"]\.\/([^'"]+)['"](?:\s+layer\(([^)]+)\))?/);
      if (!match) continue; // package imports (Tailwind) are outside our ownership.
      const child = match[2] ? declareLayer(layer, match[2].trim()) : layer;
      await load(path.join(path.dirname(file), match[1]), child);
    } else if (node.type === 'atrule' && node.name === 'layer') {
      const names = node.params.split(',').map(s => s.trim()).filter(Boolean);
      if (!node.nodes) { for (const name of names) declareLayer(layer, name); continue; }
      await walk(node, file, declareLayer(layer, names[0]), context);
    } else if (node.type === 'atrule' && (node.name === 'media' || node.name === 'supports')) {
      await walk(node, file, layer, [...context, `${node.name} ${norm(node.params)}`]);
    } else if (node.type === 'rule') {
      const selectors = splitSelectors(node.selector);
      const declarations = (node.nodes ?? []).filter(d => d.type === 'decl');
      entries.push({node, file, rank: rankOf(layer), order: sequence++, context: context.join(' | '), selectors, declarations});
    }
  }
}

await load(entry, undefined);

// Later cascade position wins for normal declarations of equal selector.
const later = (a, b) => { const c = compareRank(a.rank, b.rank); return c !== 0 ? c > 0 : a.order > b.order; };
// Winner index: selector -> property -> entries setting it normally.
const setters = new Map();
for (const entry of entries) for (const selector of entry.selectors) for (const decl of entry.declarations) {
  if (decl.important || decl.prop.startsWith('--')) continue;
  const key = `${selector}\u0000${decl.prop.toLowerCase()}`;
  if (!setters.has(key)) setters.set(key, []);
  setters.get(key).push(entry);
}

const dead = [];
for (const entry of entries) for (const decl of entry.declarations) {
  if (decl.important || decl.prop.startsWith('--')) continue;
  const prop = decl.prop.toLowerCase();
  const shadowed = entry.selectors.every(selector => (setters.get(`${selector}\u0000${prop}`) ?? []).some(other =>
    other !== entry && later(other, entry) && (other.context === '' || other.context === entry.context)));
  if (shadowed) dead.push({entry, decl});
}

const rel = file => path.relative(path.resolve(root, '..'), file).replaceAll('\\', '/');
if (!write) {
  for (const {entry, decl} of dead.slice(0, 40)) console.log(`${rel(entry.file)}:${decl.source.start.line} ${entry.node.selector.replace(/\s+/g, ' ').slice(0, 70)} { ${decl.prop} }`);
  console.log(`${dead.length} shadowed declarations`);
  process.exit(dead.length ? 1 : 0);
}

for (const {decl} of dead) decl.remove();
const prune = container => {
  for (const node of [...(container.nodes ?? [])]) {
    if (node.nodes) prune(node);
    if ((node.type === 'rule' || (node.type === 'atrule' && ['media', 'supports', 'layer'].includes(node.name) && node.nodes)) && node.nodes.length === 0) node.remove();
  }
};
for (const [file, ast] of files) {
  prune(ast);
  const next = ast.toString();
  if (next !== await readFile(file, 'utf8')) { await writeFile(file, next); console.log(`updated ${rel(file)}`); }
}
console.log(`removed ${dead.length} shadowed declarations`);

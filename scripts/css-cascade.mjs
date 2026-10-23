/**
 * Reports declarations that may be overridden by a later cascade position.
 * Review each candidate before removing it: an earlier value may be a fallback
 * for browsers that do not support the later value.
 *
 *   node scripts/css-cascade.mjs          report and fail when any exist
 *
 * Only normal (non-!important) declarations with exactly matching selector text
 * in different rules or layers are candidates. Repeats within one rule are
 * outside this check's scope. Place "css-cascade-ignore: reason" in a comment
 * immediately before a declaration to keep an intentional fallback.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

const root = path.resolve(import.meta.dirname, '..', 'web');
const entry = path.join(root, 'app.css');
if (process.argv.includes('--write')) throw new Error('--write is unsupported: review CSS fallback declarations before editing them.');
if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv.slice(2).join(' ')}`);

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
      const params = node.params.trim();
      if (container.type !== 'root') throw new Error(`Unsupported local @import at ${file}:${node.source.start.line}: ${params}`);
      // Tailwind package imports are outside our ownership. Every other import
      // must be an unconditional local import in the form below.
      if (/^(['"])tailwindcss\/(theme|utilities)\.css\1\s+layer\(\2\)$/.test(params)) continue;
      const match = params.match(/^(['"])\.\/([^'"]+)\1(?:\s+layer\(([a-zA-Z_][\w-]*)\))?$/);
      if (!match) throw new Error(`Unsupported local @import at ${file}:${node.source.start.line}: ${params}`);
      const child = match[3] ? declareLayer(layer, match[3]) : layer;
      await load(path.join(path.dirname(file), match[2]), child);
    } else if (node.type === 'atrule' && node.name === 'layer') {
      const names = node.params.split(',').map(s => s.trim()).filter(Boolean);
      if (!node.nodes) { for (const name of names) declareLayer(layer, name); continue; }
      await walk(node, file, declareLayer(layer, names[0]), context);
    } else if (node.type === 'atrule' && (node.name === 'media' || node.name === 'supports')) {
      await walk(node, file, layer, [...context, `${node.name} ${node.params}`]);
    } else if (node.type === 'rule') {
      const selector = node.selector.trim();
      const declarations = (node.nodes ?? []).filter(d => d.type === 'decl');
      entries.push({node, file, rank: rankOf(layer), order: sequence++, context: JSON.stringify(context), selector, declarations});
    }
  }
}

await load(entry, undefined);

// Later cascade position wins for normal declarations of equal selector.
const later = (a, b) => { const c = compareRank(a.rank, b.rank); return c !== 0 ? c > 0 : a.order > b.order; };
const ignored = decl => {
  const comment = decl.prev();
  if (comment?.type !== 'comment' || !comment.text.trim().startsWith('css-cascade-ignore:')) return false;
  if (!comment.text.trim().slice('css-cascade-ignore:'.length).trim()) {
    throw new Error(`css-cascade-ignore needs a reason at ${decl.source.input.file}:${comment.source.start.line}`);
  }
  return true;
};
// Candidate index: complete selector text -> property -> entries setting it normally.
const setters = new Map();
for (const entry of entries) for (const decl of entry.declarations) {
  if (decl.important || decl.prop.startsWith('--')) continue;
  const key = `${entry.selector}\u0000${decl.prop.toLowerCase()}`;
  if (!setters.has(key)) setters.set(key, []);
  setters.get(key).push(entry);
}

const candidates = [];
for (const entry of entries) for (const decl of entry.declarations) {
  if (decl.important || decl.prop.startsWith('--') || ignored(decl)) continue;
  const prop = decl.prop.toLowerCase();
  const shadowed = (setters.get(`${entry.selector}\u0000${prop}`) ?? []).some(other =>
    other !== entry && later(other, entry) && (other.context === '[]' || other.context === entry.context));
  if (shadowed) candidates.push({entry, decl});
}

const rel = file => path.relative(path.resolve(root, '..'), file).replaceAll('\\', '/');
for (const {entry, decl} of candidates.slice(0, 40)) console.log(`${rel(entry.file)}:${decl.source.start.line} ${entry.selector.replace(/\s+/g, ' ').slice(0, 70)} { ${decl.prop} }`);
console.log(`${candidates.length} possible overrides (review fallbacks before removing)`);
process.exit(candidates.length ? 1 : 0);

/**
 * Reports selectors whose same property is set from more than one owner, where
 * an owner is a (source file, full layer path) pair in the app.css import graph.
 *
 *   node scripts/css-duplicates.mjs           compare with docs/css-duplicates.json
 *   node scripts/css-duplicates.mjs --print   print the current inventory as JSON
 *
 * The key is the exact trimmed selector text, the raw @media/@supports context
 * stack and the property (lowercased, except case-sensitive custom properties).
 * Values, !important and css-cascade-ignore do not change membership; each owner
 * records whether any of its declarations is !important. Repeats within one
 * owner are not reported. Shorthands and longhands are different properties.
 *
 * The check fails when a group or an owner is missing from the baseline. Groups
 * or owners that disappeared are listed but do not fail; remove them from the
 * baseline by hand. The baseline is never rewritten by this script.
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseStyles} from './css-cascade.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const entry = path.join(repo, 'web', 'app.css');
const baselineFile = path.join(repo, 'docs', 'css-duplicates.json');
const args = process.argv.slice(2);
if (args.includes('--write')) throw new Error('--write is unsupported: edit docs/css-duplicates.json by hand after review.');
if (args.length > 1 || (args.length === 1 && args[0] !== '--print')) throw new Error(`Unknown argument: ${args.join(' ')}`);

const rel = file => path.relative(repo, file).replaceAll('\\', '/');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const groupKey = g => JSON.stringify([g.selector, g.context, g.property]);
const ownerKey = o => JSON.stringify([o.file, o.layer]);

// Group key -> owner key -> owner.
const groups = new Map();
for (const rule of await parseStyles(entry)) {
  const context = JSON.parse(rule.context);
  for (const decl of rule.declarations) {
    const property = decl.prop.startsWith('--') ? decl.prop : decl.prop.toLowerCase();
    const group = {selector: rule.selector, context, property};
    const key = groupKey(group);
    if (!groups.has(key)) groups.set(key, {...group, owners: new Map()});
    const owners = groups.get(key).owners;
    const owner = {file: rel(rule.file), layer: rule.layer};
    const existing = owners.get(ownerKey(owner));
    if (existing) existing.important ||= Boolean(decl.important);
    else owners.set(ownerKey(owner), {...owner, important: Boolean(decl.important)});
  }
}

const duplicates = [...groups.values()]
  .filter(g => g.owners.size > 1)
  .map(g => ({selector: g.selector, context: g.context, property: g.property,
    owners: [...g.owners.values()].sort((a, b) => cmp(a.file, b.file) || cmp(a.layer, b.layer))}))
  .sort((a, b) => cmp(groupKey(a), groupKey(b)));

if (args[0] === '--print') {
  process.stdout.write(`${JSON.stringify({version: 1, duplicates}, null, 2)}\n`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
} catch (error) {
  throw new Error(`Unable to read ${rel(baselineFile)}: ${error.message}`);
}
const valid = baseline?.version === 1 && Array.isArray(baseline.duplicates) && baseline.duplicates.every(g =>
  typeof g?.selector === 'string' && Array.isArray(g.context) && g.context.every(c => typeof c === 'string') &&
  typeof g.property === 'string' && Array.isArray(g.owners) &&
  g.owners.every(o => typeof o?.file === 'string' && typeof o.layer === 'string'));
if (!valid) throw new Error(`Malformed ${rel(baselineFile)}: expected {version: 1, duplicates: [{selector, context, property, owners}]}`);

const known = new Map(baseline.duplicates.map(g => [groupKey(g), new Set(g.owners.map(ownerKey))]));
const current = new Map(duplicates.map(g => [groupKey(g), new Set(g.owners.map(ownerKey))]));
const describe = (g, owners) => {
  const where = g.context.length ? ` @ ${g.context.join(' / ')}` : '';
  return `${g.selector.replace(/\s+/g, ' ').slice(0, 70)}${where} { ${g.property} } ${owners.map(o => `${o.file}[${o.layer || '-'}]`).join(', ')}`;
};

const added = [];
for (const g of duplicates) {
  const seen = known.get(groupKey(g));
  const fresh = seen ? g.owners.filter(o => !seen.has(ownerKey(o))) : g.owners;
  if (fresh.length) added.push(describe(g, fresh));
}
const stale = [];
for (const g of baseline.duplicates) {
  const now = current.get(groupKey(g));
  const gone = now ? g.owners.filter(o => !now.has(ownerKey(o))) : g.owners;
  if (gone.length) stale.push(describe(g, gone));
}

for (const line of added) console.log(`new: ${line}`);
for (const line of stale) console.log(`stale: ${line}`);
const hint = stale.length ? ` (remove stale entries from ${rel(baselineFile)})` : '';
console.log(`${duplicates.length} duplicate groups; ${added.length} new; ${stale.length} stale${hint}`);
process.exit(added.length ? 1 : 0);

import type { SqlValue } from '../contracts/db.js';
export function bindings(params: readonly SqlValue[] = []): readonly SqlValue[] {
  for (const value of params) if (!(value === null || typeof value === 'string' || value instanceof Uint8Array || typeof value === 'number' && Number.isFinite(value))) throw new TypeError('Invalid SQL binding');
  return params;
}
/** Canonical ? scanner: strings, identifiers, E strings, nested comments and dollar quotes. */
export function postgresSql(sql: string): string {
  let out = '', i = 0, count = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const quote = c, escaped = quote === "'" && /(?:^|[^\w])E$/i.test(sql.slice(0, i));
      out += c; i++;
      let ended = false;
      while (i < sql.length) {
        const t = sql[i++]!; out += t;
        if (escaped && t === '\\' && i < sql.length) { out += sql[i++]!; continue; }
        if (t === quote) { if (sql[i] === quote) { out += sql[i++]!; } else { ended = true; break; } }
      }
      if (!ended) throw new Error('Unterminated SQL quote');
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i); const n = end < 0 ? sql.length : end + 1; out += sql.slice(i, n); i = n;
    } else if (sql.startsWith('/*', i)) {
      const start = i; i += 2; let depth = 1;
      while (i < sql.length && depth) { if (sql.startsWith('/*', i)) { depth++; i += 2; } else if (sql.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Unterminated SQL comment'); out += sql.slice(start, i);
    } else if (c === '$' && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i-1]!)) && /^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/)![0];
      const end = sql.indexOf(tag, i + tag.length); if (end < 0) throw new Error('Unterminated SQL dollar quote'); out += sql.slice(i, end + tag.length); i = end + tag.length;
    } else { out += c === '?' ? `$${++count}` : c; i++; }
  }
  return out;
}
export function safeNumber(value: number | bigint): number {
  const n = Number(value); if (!Number.isSafeInteger(n)) throw new RangeError('SQL integer exceeds safe range'); return n;
}

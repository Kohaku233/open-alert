import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { executeSqliteProxyQuery } from '../src/db/sqlite-proxy.js';

test('node:sqlite proxy keeps projection order, rejects collapsed names, and does not invent a missed row', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (id TEXT, name TEXT)');
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run('a', 'b');
    const prepare = (sql: string) => db.prepare(sql);
    const selected = executeSqliteProxyQuery(prepare, db.prepare('SELECT name, id FROM t'), [], 'all');
    assert.deepEqual(selected.rows, [['b', 'a']]);
    const miss = executeSqliteProxyQuery(prepare, db.prepare('SELECT id, name FROM t WHERE id = ?'), ['missing'], 'get');
    assert.equal(miss.rows, undefined);
    assert.throws(() => executeSqliteProxyQuery(prepare, db.prepare('SELECT id, id FROM t'), [], 'all'), /duplicate columns/);
    const updated = executeSqliteProxyQuery(prepare, db.prepare('UPDATE t SET name = ? WHERE id = ?'), ['c', 'a'], 'run');
    assert.equal(updated.changes, 1);
    assert.equal(db.prepare('SELECT name FROM t WHERE id = ?').get('a')?.name, 'c');
  } finally { db.close(); }
});

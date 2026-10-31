import type { SqlDatabase } from '../contracts/db.js';

/** Read authority from persisted identity, never from a requested plan or payload. */
export async function hasUnlimitedQuotas(db: SqlDatabase, userId: string): Promise<boolean> {
  const rows = await db.query<{ role: string }>('SELECT role FROM "user" WHERE id=?', [userId]);
  return rows[0]?.role === 'admin';
}

/** SQL form keeps capacity and delivery decisions inside their atomic writes. */
export const administrator = (user: string) => `EXISTS(SELECT 1 FROM "user" quota_user WHERE quota_user.id=${user} AND quota_user.role='admin')`;
export const ordinaryOwner = (user: string) => `EXISTS(SELECT 1 FROM "user" quota_user WHERE quota_user.id=${user} AND quota_user.role<>'admin')`;

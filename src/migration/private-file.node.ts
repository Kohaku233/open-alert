import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { LegacyMigrationError, MAX_LEGACY_BYTES } from './legacy.js';
/** No-follow + descriptor checks close symlink/swap races; Windows callers must set a private ACL. */
export async function readPrivateJson(path: string, maxBytes = MAX_LEGACY_BYTES): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new LegacyMigrationError('private_file_required');
  const file = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new LegacyMigrationError('private_file_required');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const r = await file.read(buffer,offset,buffer.length-offset,null);
      if (!r.bytesRead) break; offset += r.bytesRead;
    }
    if (offset > maxBytes) throw new LegacyMigrationError('snapshot_too_large');
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,offset))); }
    catch { throw new LegacyMigrationError('invalid_json'); }
  } finally { await file.close(); }
}
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const file = await open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);
  try { await file.writeFile(text,'utf8'); await file.sync(); } finally { await file.close(); }
}

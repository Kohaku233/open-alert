/** Run the unchanged test tree on local disk when a FUSE mount makes package imports slow. */
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exists = async path => {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export async function prepareTestExecution(root, { local = false, refresh = false } = {}) {
  // FUSE's per-file round trips can take longer than the entire batch budget.
  // Ordinary local installations continue to run directly from the project tree.
  const mounted = process.platform === 'linux' && (await statfs(root)).type === 0x65735546;
  if (!local && !mounted) return { root, staged: false, cleanup: async () => {} };
  const dependencyRoot = resolve(root, 'node_modules');
  const lock = await readFile(resolve(root, 'package-lock.json'));
  const installedLock = await readFile(resolve(dependencyRoot, '.package-lock.json'));
  const dependencyKey = createHash('sha256').update(root).update(lock).update(installedLock)
    .update(`${process.version}:${process.platform}:${process.arch}`).digest('hex').slice(0, 24);
  // Cowork sets TMPDIR to a session mount too; Linux /tmp is the actual local disk.
  const cacheParent = join(process.platform === 'linux' ? '/tmp' : tmpdir(), `open-alert-tests-${process.getuid?.() ?? 'local'}`);
  await mkdir(cacheParent, { recursive: true, mode: 0o700 });
  const cache = join(cacheParent, dependencyKey);
  if (refresh) await rm(cache, { recursive: true, force: true });
  const modules = join(cache, 'node_modules');
  const complete = join(cache, 'complete');
  console.log(`STAGING: ${await exists(complete) ? 'reuse' : 'copy'} installed dependencies on local disk (${dependencyKey})`);
  const heartbeat = setInterval(() => console.log('STAGING: local test snapshot preparation in progress'), 10_000);
  let snapshot;
  try {
    if (!await exists(complete)) {
      await mkdir(modules, { recursive: true });
      const markers = join(cache, 'copied');
      await mkdir(markers, { recursive: true });
      // Top-level completion markers allow an interrupted first copy to resume.
      // No npm install, dependency replacement, loader mock or transpilation is involved.
      for (const entry of await readdir(dependencyRoot)) {
        const marker = join(markers, entry);
        if (await exists(marker)) continue;
        const destination = join(modules, entry);
        const pending = join(cache, 'copy-in-progress');
        await rm(pending, { recursive: true, force: true });
        await cp(join(dependencyRoot, entry), pending, { recursive: true, verbatimSymlinks: true });
        await rm(destination, { recursive: true, force: true });
        await rename(pending, destination);
        await writeFile(marker, 'copied\n');
      }
      await writeFile(complete, `${dependencyKey}\n`);
    }
    snapshot = await mkdtemp(join(cacheParent, 'run-'));
    await symlink(modules, join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    // Copy only execution inputs. In particular, never copy .env or live database state.
    for (const name of ['src', 'test', 'scripts', 'migrations', 'dist', 'package.json', 'package-lock.json', 'wrangler.jsonc', 'tsconfig.json', 'tsconfig.build.json']) {
      const source = join(root, name);
      if (await exists(source)) await cp(source, join(snapshot, name), { recursive: true, verbatimSymlinks: true });
    }
    console.log(`STAGING: ready ${snapshot}`);
    return { root: snapshot, staged: true, dependencyKey, cleanup: () => rm(snapshot, { recursive: true, force: true }) };
  } catch (error) {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
    throw error;
  } finally { clearInterval(heartbeat); }
}

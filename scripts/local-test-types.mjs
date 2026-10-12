/** Native Node >=22.15 test loader; executes unmodified operator CLI without an esbuild service child.
 * OPEN_ALERT_TEST_NODE_MODULES optionally points at an identical local dependency cache
 * when mounted node_modules is slow. No module implementations are mocked by this loader.
 */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.env.OPEN_ALERT_LOCAL_TEST !== '1') throw new Error('Native test TS loader is local-test only');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.OPEN_ALERT_TEST_NODE_MODULES && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('file:') && existsSync(process.env.OPEN_ALERT_TEST_NODE_MODULES+'/'+specifier.split('/').slice(0,specifier.startsWith('@')?2:1).join('/')+'/package.json')) {
      return nextResolve(specifier, {...context,parentURL:pathToFileURL(process.env.OPEN_ALERT_TEST_NODE_MODULES + '/../test-entry.mjs').href});
    }
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url:candidate.href, shortCircuit:true };
    }
    return nextResolve(specifier,context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
      return { format:'module', source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url}), shortCircuit:true };
    }
    return nextLoad(url,context);
  },
});

import { migrationChecksum } from '../src/db/migrations.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/node.js';
import { checkLegacyMergeTarget, importLegacyState, LegacyMigrationError, planLegacyImport, releaseLegacyHold } from '../src/migration/legacy.js';
import type { LegacyImportOptions } from '../src/migration/legacy.js';
import { buildD1Artifact } from '../src/migration/d1-artifact.js';
import { readPrivateJson, writePrivateFile } from '../src/migration/private-file.node.js';

const usage = 'node --import tsx scripts/migrate-legacy.ts --target node|cloudflare --source-id ID --owner-id ID --owner-email EMAIL [--snapshot PRIVATE.json] (--dry-run | --apply | --stage PRIVATE.artifact.json | --release-held --confirm-source-stopped) [--channel-file PRIVATE.json] [--merge-existing --settings-generation N --channel-generation N]';
async function main(): Promise<void> {
  const args = process.argv.slice(2), values = new Map<string,string>(), flags = new Set<string>();
  const switches = new Set(['--dry-run','--apply','--release-held','--confirm-source-stopped','--merge-existing']);
  const valueNames = new Set(['--target','--source-id','--owner-id','--owner-email','--snapshot','--channel-file','--stage','--settings-generation','--channel-generation']);
  for (let i=0;i<args.length;i++) {
    const key = args[i]!;
    if (switches.has(key)) { if (flags.has(key)) throw new LegacyMigrationError('invalid_arguments'); flags.add(key); }
    else if (valueNames.has(key)) { const value=args[++i]; if (!value || value.startsWith('--') || values.has(key)) throw new LegacyMigrationError('invalid_arguments'); values.set(key,value); }
    else throw new LegacyMigrationError('invalid_arguments');
  }
  const target = values.get('--target') ?? 'node';
  const modes = [...['--dry-run','--apply','--release-held'].filter(x=>flags.has(x)),...(values.has('--stage')?['--stage']:[])];
  if (!['node','cloudflare'].includes(target) || modes.length !== 1 || !values.has('--source-id') || !values.has('--owner-id') || !values.has('--owner-email')) throw new LegacyMigrationError('invalid_arguments');
  if (target === 'cloudflare' && !['--dry-run','--stage'].includes(modes[0]!)) throw new LegacyMigrationError('d1_offline_stage_only');
  if (modes[0] !== '--release-held' && !values.has('--snapshot') || modes[0] === '--release-held' && (!flags.has('--confirm-source-stopped') || values.has('--snapshot') || values.has('--channel-file')) || flags.has('--confirm-source-stopped') && modes[0] !== '--release-held') throw new LegacyMigrationError('invalid_arguments');
  const owner = {userId:values.get('--owner-id')!,email:values.get('--owner-email')!}, sourceId=values.get('--source-id')!;
  // Offline Cloudflare dry-run needs neither Cloudflare credentials nor a runtime config.
  // Applying/staging channels requires the NEW installation's encryption key, never the old environment.
  const options: LegacyImportOptions = {sourceId,owner};
  if (values.has('--channel-file') && modes[0] !== '--dry-run') {
    options.channelSecrets = async()=>await readPrivateJson(values.get('--channel-file')!,4096) as {userKey:string;appToken?:string|null};
    if (process.env.ENCRYPTION_KEY) options.encryptionKey = process.env.ENCRYPTION_KEY;
  }
  if (flags.has('--merge-existing') && modes[0] === '--release-held' || !flags.has('--merge-existing') && (values.has('--settings-generation') || values.has('--channel-generation')) || flags.has('--merge-existing') && values.has('--channel-file')) throw new LegacyMigrationError('invalid_arguments');
  if (target === 'cloudflare' && flags.has('--merge-existing')) {
    const sg=values.get('--settings-generation'), cg=values.get('--channel-generation');
    if(!sg || !cg || !/^\d+$/.test(sg) || !/^\d+$/.test(cg)) throw new LegacyMigrationError('invalid_merge_target');
    options.mergeExisting={settingsGeneration:Number(sg),channelGeneration:Number(cg)};
  }
  if (target === 'node' && (values.has('--settings-generation') || values.has('--channel-generation'))) throw new LegacyMigrationError('invalid_arguments');
  if (target === 'cloudflare') {
    const plan = await planLegacyImport(await readPrivateJson(values.get('--snapshot')!),options);
    if (values.has('--stage')) {
      const artifact = await buildD1Artifact(plan,options);
      await writePrivateFile(values.get('--stage')!,JSON.stringify(artifact,null,2)+'\n');
      console.log(JSON.stringify({status:'staged_offline',target,fingerprint:plan.fingerprint,...plan.summary,targetValidation:'deferred_to_D1_atomicCAS',held:true}));
    } else console.log(JSON.stringify({status:'dry_run_offline',target,fingerprint:plan.fingerprint,...plan.summary,targetValidation:'requires_existing_verified_admin_at_apply',held:true}));
    return;
  }
  if (modes[0] === '--stage') throw new LegacyMigrationError('stage_requires_cloudflare');
  // Validate full deployment config, including actual SMTP/Resend settings. No email transport is instantiated.
  const config = loadConfig(process.env);
  if (config.deployment !== 'node') throw new LegacyMigrationError('node_config_required');
  options.limits = config.limits;
  const db = await createDb(config,{deployment:'node'});
  try {
    if (flags.has('--merge-existing')) {
      const key=`legacy-import:source:${await migrationChecksum(sourceId)}`;
      const ledger=await db.query<{value:string}>('SELECT value FROM app_meta WHERE key=?',[key]);
      // A committed merge reuses its original generations; importLegacyState verifies the fingerprint before any write.
      options.mergeExisting=ledger[0] ? JSON.parse(ledger[0].value).mergeExisting : await checkLegacyMergeTarget(db,owner);
      if(!options.mergeExisting) throw new LegacyMigrationError('source_already_imported_differently');
    }
    if (modes[0] === '--release-held') {
      console.log(JSON.stringify({status:await releaseLegacyHold(db,{sourceId,owner,confirmSourceStopped:true}),target}));
    } else {
      const result = await importLegacyState(db,await readPrivateJson(values.get('--snapshot')!),{...options,dryRun:flags.has('--dry-run')});
      console.log(JSON.stringify({status:result.status,target,fingerprint:result.plan.fingerprint,...result.plan.summary,held:true}));
    }
  } finally { await db.close(); }
}
main().catch((error: unknown)=>{
  // Never print snapshot values, provider secrets, DB URLs, stack traces or raw SQL errors.
  const code = error instanceof LegacyMigrationError ? error.code : 'migration_failed';
  console.error(JSON.stringify({status:'error',code}));
  if (code==='invalid_arguments') console.error(usage);
  process.exitCode=1;
});

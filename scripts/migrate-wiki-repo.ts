/**
 * migrate-wiki-repo.ts
 *
 * Before the wiki was multi-repo, documents had ids `<branch>:<slug>` /
 * `<branch>:snapshot` and no `repo` field. This copies them to repo-qualified
 * ids (`<repo>:<branch>:<slug>`) with `repo` set, so an existing wiki keeps
 * working without regenerating anything.
 *
 * Non-destructive by default: the copy leaves the old documents in place.
 *
 * Usage:
 *   npm run migrate-wiki-repo --workspace=apps/wiki -- --repo=owner/name              # dry run
 *   npm run migrate-wiki-repo --workspace=apps/wiki -- --repo=owner/name --apply      # copy
 *   npm run migrate-wiki-repo --workspace=apps/wiki -- --repo=owner/name --delete-old # remove verified originals
 *
 * --repo defaults to WIKI_DEFAULT_REPO. --delete-old only removes a legacy
 * document whose repo-qualified copy exists.
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '',
      'Usage:',
      '  npm run migrate-wiki-repo --workspace=apps/wiki -- [--repo=owner/name] [--apply | --delete-old]',
      '',
      '  (no flag)     dry run: list what would be copied',
      '  --apply       copy legacy documents to repo-qualified ids',
      '  --delete-old  delete legacy documents that already have a verified copy',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const envPath = resolve(__dirname, '../.env.local');
if (existsSync(envPath)) config({ path: envPath });

(async () => {
  const { getDb, VECTORIZE_MAX_CHARS } = await import('../lib/astra');
  const { parseRepoKey, topicId, snapshotId } = await import('../lib/wiki/types');

  const repo = parseRepoKey(args.find((a) => a.startsWith('--repo='))?.slice(7) ?? process.env.WIKI_DEFAULT_REPO);
  if (!repo) throw new Error('Pass --repo=owner/name (or set WIKI_DEFAULT_REPO).');

  const apply = args.includes('--apply');
  const deleteOld = args.includes('--delete-old');
  const col = getDb().collection('wiki_toc_v2');

  // Legacy documents are the ones with no `repo` field.
  const legacy: Record<string, any>[] = [];
  for await (const doc of col.find({ repo: { $exists: false } } as any)) {
    legacy.push(doc as Record<string, any>);
  }

  const plan = legacy.flatMap((doc) => {
    if (doc.kind === 'topic' && doc.branch && doc.slug) {
      return [{ doc, newId: topicId(repo, doc.branch, doc.slug) }];
    }
    if (doc.kind === 'snapshot' && doc.branch) {
      return [{ doc, newId: snapshotId(repo, doc.branch) }];
    }
    console.warn(`[migrate] skipping unrecognised document ${String(doc._id)}`);
    return [];
  });

  console.log(`[migrate] repo: ${repo} — ${plan.length} legacy document(s)${apply || deleteOld ? '' : ' (dry run)'}`);
  for (const { doc, newId } of plan) console.log(`  ${doc.kind.padEnd(8)} ${String(doc._id)}  →  ${newId}`);

  if (apply) {
    let copied = 0;
    for (const { doc, newId } of plan) {
      const copy: Record<string, any> = { ...doc, _id: newId, repo };
      // Reads don't return $vectorize, so topics get it back.
      if (copy.kind === 'topic') {
        copy.$vectorize = `${copy.title} ${copy.description}`.slice(0, VECTORIZE_MAX_CHARS);
      }
      await col.findOneAndReplace({ _id: newId } as any, copy as any, { upsert: true });
      copied++;
    }
    console.log(`[migrate] copied ${copied} document(s). Verify the wiki, then re-run with --delete-old.`);
  }

  if (deleteOld) {
    let deleted = 0;
    for (const { doc, newId } of plan) {
      const copy = await col.findOne({ _id: newId } as any);
      if (!copy) {
        console.warn(`[migrate] keeping ${String(doc._id)}: no copy at ${newId}`);
        continue;
      }
      await col.deleteOne({ _id: doc._id } as any);
      deleted++;
    }
    console.log(`[migrate] deleted ${deleted} legacy document(s).`);
  }
})().catch((err: unknown) => {
  console.error('[migrate] ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * regen-wiki-pictures.ts
 *
 * Regenerates only the picture-book page of every stored topic on a branch —
 * e.g. after the picture prompt changes — at the commit its wiki page was
 * built from, so both modes keep citing the same commit.
 * Wiki pages and topics are left as they are.
 *
 * Usage:
 *   npx tsx scripts/regen-wiki-pictures.ts [branch] [--broken]
 *     branch defaults to main; --broken redoes only pages with a card that isn't valid JSON.
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(__dirname, '../.env.local');
if (existsSync(envPath)) config({ path: envPath });

const args = process.argv.slice(2);
const branch = args.find((a) => !a.startsWith('--')) ?? 'main';
const onlyBroken = args.includes('--broken');

function hasBrokenCard(page: string | undefined): boolean {
  return [...(page ?? '').matchAll(/```picture\n([\s\S]*?)(?:```|$)/g)].some(([, source]) => {
    try {
      JSON.parse(source);
      return false;
    } catch {
      return true;
    }
  });
}
const CONCURRENCY = 3;

(async () => {
  const { getStoredTopics, getSnapshot, saveTopics } = await import('../lib/wiki/store');
  const { generatePagesForTopic } = await import('../lib/wiki/generate');
  const { decodeFileList } = await import('../lib/wiki/snapshot');

  const [stored, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
  const topics = onlyBroken ? stored.filter((t) => hasBrokenCard(t.generatedPagePicture)) : stored;
  if (!snapshot || stored.length === 0) {
    console.error(`[regen-pictures] no stored topics for branch "${branch}"`);
    process.exit(1);
  }
  const allPaths = decodeFileList(snapshot.fileListText).map((e) => e.path);
  console.log(`[regen-pictures] ${topics.length} topics on "${branch}" at ${snapshot.headSha.slice(0, 7)}`);

  let failed = 0;
  const queue = [...topics];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let topic = queue.shift(); topic; topic = queue.shift()) {
        try {
          const commit = topic.pageCommitSha ?? snapshot.headSha;
          const { picture } = await generatePagesForTopic(topic, branch, commit, allPaths, ['picture']);
          if (!picture) throw new Error('empty page');
          await saveTopics([{ ...topic, generatedPagePicture: picture, pageCommitSha: commit }]);
          console.log(`[regen-pictures] ✓ ${topic.title}`);
        } catch (err) {
          failed++;
          console.error(`[regen-pictures] ✗ ${topic.title}:`, err);
        }
      }
    }),
  );
  console.log(`[regen-pictures] done: ${topics.length - failed} regenerated, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

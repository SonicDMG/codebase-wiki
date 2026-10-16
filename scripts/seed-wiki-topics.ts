/**
 * seed-wiki-topics.ts
 *
 * Ensures wiki topics are generated and synced for a given branch.
 * Calls ensureTopics(branch) then syncBranch(branch) and prints a summary.
 *
 * Usage:
 *   npm run seed-wiki --workspace=packages/api -- [branch]
 *   npm run seed-wiki --workspace=packages/api -- main
 *   npm run seed-wiki --workspace=packages/api -- --help
 *
 * branch defaults to 'main'.
 * Exit code 0 on success, 1 on failure.
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// ── --help / -h ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '',
      'Usage:',
      '  npm run seed-wiki --workspace=packages/api -- [branch]',
      '',
      'Arguments:',
      '  branch    Git branch to seed/sync (default: main)',
      '',
      'Options:',
      '  --help, -h  Print this message and exit',
      '',
      'Behaviour:',
      '  1. Loads packages/api/.env.local (if present).',
      '  2. Calls ensureTopics(branch) — returns stored topics or runs initial generation.',
      '  3. Calls syncBranch(branch) — diffs against the branch head and absorbs changes.',
      '  4. Prints a summary: branch, topic count, titles, headSha, generated flag, sync status.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// ── env loading ───────────────────────────────────────────────────────────────

const envPath = resolve(__dirname, '../.env.local');
if (existsSync(envPath)) {
  config({ path: envPath });
}

// ── main (dynamic import keeps env ahead of db/llm clients) ──────────────────

const branch = args[0] ?? 'main';

(async () => {
  const { ensureTopics, syncBranch } = await import('../lib/wiki/sync');

  console.log(`[seed-wiki] branch: ${branch}`);

  // Step 1 — ensure topics exist (generates if needed).
  const { topics, snapshot, generated } = await ensureTopics(branch);
  console.log(
    `[seed-wiki] ensureTopics → ${topics.length} topic(s), generated=${generated}, headSha=${snapshot.headSha}`,
  );

  // Step 2 — sync against branch head.
  const outcome = await syncBranch(branch);

  // Summary
  console.log('');
  console.log('── Wiki Topic Seed Summary ──────────────────────────────────');
  console.log(`  branch      : ${outcome.branch}`);
  console.log(`  topics      : ${outcome.topics.length}`);
  console.log(`  headSha     : ${outcome.headSha}`);
  console.log(`  generated   : ${generated}`);
  console.log(`  sync status : ${outcome.status}`);
  if (outcome.changeSummary) {
    console.log(`  changes     : ${outcome.changeSummary}`);
  }
  if (outcome.warning) {
    console.log(`  warning     : ${outcome.warning}`);
  }
  console.log('');
  console.log('  Topics:');
  for (const t of outcome.topics) {
    console.log(`    • ${t.title}`);
  }
  console.log('─────────────────────────────────────────────────────────────');
})().catch((err: unknown) => {
  console.error('[seed-wiki] ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});

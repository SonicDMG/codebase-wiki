/**
 * seed-wiki-topics.ts
 *
 * Ensures wiki topics are generated and synced for a given repo + branch.
 * Calls ensureTopics then syncBranch and prints a summary.
 *
 * Usage:
 *   npm run seed-wiki --workspace=apps/wiki -- --repo=owner/name [branch]
 *   npm run seed-wiki --workspace=apps/wiki -- --repo=owner/name main
 *   npm run seed-wiki --workspace=apps/wiki -- --help
 *
 * --repo defaults to WIKI_DEFAULT_REPO; branch defaults to 'main'.
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
      '  npm run seed-wiki --workspace=apps/wiki -- [--repo=owner/name] [branch]',
      '',
      'Arguments:',
      '  --repo    GitHub repo as owner/name (default: $WIKI_DEFAULT_REPO)',
      '  branch    Git branch to seed/sync (default: main)',
      '',
      'Options:',
      '  --help, -h  Print this message and exit',
      '',
      'Behaviour:',
      '  1. Loads apps/wiki/.env.local (if present).',
      '  2. Calls ensureTopics(repo, branch) — returns stored topics or runs initial generation.',
      '  3. Calls syncBranch(repo, branch) — diffs against the branch head and absorbs changes.',
      '  4. Prints a summary: repo, branch, topic count, titles, headSha, generated flag, sync status.',
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

const branch = args.find((a) => !a.startsWith('--')) ?? 'main';

(async () => {
  const { ensureTopics, syncBranch } = await import('../lib/wiki/sync');
  const { parseRepoKey } = await import('../lib/wiki/types');

  const repo = parseRepoKey(args.find((a) => a.startsWith('--repo='))?.slice(7) ?? process.env.WIKI_DEFAULT_REPO);
  if (!repo) throw new Error('Pass --repo=owner/name (or set WIKI_DEFAULT_REPO).');

  console.log(`[seed-wiki] repo: ${repo}  branch: ${branch}`);

  // Step 1 — ensure topics exist (generates if needed).
  const { topics, snapshot, generated } = await ensureTopics(repo, branch);
  console.log(
    `[seed-wiki] ensureTopics → ${topics.length} topic(s), generated=${generated}, headSha=${snapshot.headSha}`,
  );

  // Step 2 — sync against branch head.
  const outcome = await syncBranch(repo, branch);

  // Summary
  console.log('');
  console.log('── Wiki Topic Seed Summary ──────────────────────────────────');
  console.log(`  repo        : ${outcome.repo}`);
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

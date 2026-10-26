/**
 * backfill.ts — one-time fill-in of page fingerprints for pages generated
 * before fingerprints were stored.
 *
 * The fingerprint of an existing page is computed over the file tree AT THE
 * COMMIT THE PAGE WAS BUILT FROM (`topic.pageCommitSha`), never the current
 * head — otherwise a genuinely stale page would be stamped as current.
 *
 * Pages that can't be verified (no commit sha, placeholder text, invalid
 * picture cards, tree unavailable or truncated) get NO fingerprint, so they
 * keep classifying as 'missing-or-failed'.
 *
 * Never calls the LLM. Re-running writes nothing for pages that already have
 * a fingerprint, and makes no GitHub calls if nothing needs filling.
 */

import { getFileTreeResult } from '@/lib/github';
import { computeFingerprint } from './fingerprint';
import { FETCH_FAILED_PAGE, NO_SOURCE_FILES_PAGE } from './generate';
import { ORIGINAL_TEMPLATE_VERSION } from './prompts';
import { hasPictureCards } from './staleness';
import { getStoredTopics, updateTopicFields } from './store';
import { splitRepo } from './types';
import type { RepoKey, SnapshotEntry, WikiTopicDoc } from './types';

type Mode = 'wiki' | 'picture';

export interface BackfillResult {
  repo: RepoKey;
  branch: string;
  checked: number;
  filled: number;
  unverifiable: Array<{ slug: string; mode: Mode; reason: string }>;
}

function pageFor(topic: WikiTopicDoc, mode: Mode): string | undefined {
  return mode === 'wiki' ? topic.generatedPage : topic.generatedPagePicture;
}

function fingerprintFor(topic: WikiTopicDoc, mode: Mode): string | undefined {
  return mode === 'wiki' ? topic.pageFingerprint : topic.pagePictureFingerprint;
}

/** True when the topic has a non-empty page in `mode` but no stored fingerprint. */
function needsFingerprint(topic: WikiTopicDoc, mode: Mode): boolean {
  const page = pageFor(topic, mode);
  return Boolean(page && page.trim().length > 0) && !fingerprintFor(topic, mode);
}

/** True when any topic has a non-empty page without a stored fingerprint. */
export function hasUnfingerprintedPages(topics: WikiTopicDoc[]): boolean {
  return topics.some((t) => needsFingerprint(t, 'wiki') || needsFingerprint(t, 'picture'));
}

const inFlight = new Map<string, Promise<BackfillResult>>();

/** Fill in missing fingerprints for a branch's existing pages. Concurrent calls per branch share one run. */
export function backfillBranch(repo: RepoKey, branch: string): Promise<BackfillResult> {
  const key = `${repo}:${branch}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = runBackfill(repo, branch).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function runBackfill(repo: RepoKey, branch: string): Promise<BackfillResult> {
  const { owner, name } = splitRepo(repo);
  const result: BackfillResult = { repo, branch, checked: 0, filled: 0, unverifiable: [] };
  const topics = await getStoredTopics(repo, branch);

  // Collect pages needing a fingerprint, rejecting the unverifiable ones up front.
  const work: Array<{ topic: WikiTopicDoc; mode: Mode; commitSha: string }> = [];
  for (const topic of topics) {
    for (const mode of ['wiki', 'picture'] as const) {
      if (!needsFingerprint(topic, mode)) continue;
      result.checked++;
      const page = pageFor(topic, mode)!;
      const reject = (reason: string) => result.unverifiable.push({ slug: topic.slug, mode, reason });

      if (!topic.pageCommitSha) {
        reject('no pageCommitSha stored');
      } else if (page.trim() === NO_SOURCE_FILES_PAGE || page.trim() === FETCH_FAILED_PAGE) {
        reject('page is a generation placeholder');
      } else if (mode === 'picture' && !hasPictureCards(page)) {
        reject('picture page has no valid cards');
      } else {
        work.push({ topic, mode, commitSha: topic.pageCommitSha });
      }
    }
  }

  // Fetch each distinct commit's tree once; a failed/truncated tree is cached as an error reason.
  const trees = new Map<string, SnapshotEntry[] | string>();
  for (const { topic, mode, commitSha } of work) {
    if (!trees.has(commitSha)) {
      try {
        const tree = await getFileTreeResult(owner, name, commitSha);
        trees.set(
          commitSha,
          tree.truncated
            ? `tree at ${commitSha.slice(0, 7)} is truncated`
            : tree.entries.map((e) => ({ sha: e.sha ?? '', path: e.path })),
        );
      } catch (err) {
        trees.set(
          commitSha,
          `could not fetch tree at ${commitSha.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const tree = trees.get(commitSha)!;
    if (typeof tree === 'string') {
      result.unverifiable.push({ slug: topic.slug, mode, reason: tree });
      continue;
    }

    // Pages without a fingerprint predate version tracking, so they came from the
    // original templates: stamp ORIGINAL_TEMPLATE_VERSION, not the current one.
    const fingerprint = computeFingerprint(topic.scope, tree);
    try {
      await updateTopicFields(
        topic._id,
        mode === 'wiki'
          ? { pageFingerprint: fingerprint, pageTemplateVersion: ORIGINAL_TEMPLATE_VERSION }
          : { pagePictureFingerprint: fingerprint, pagePictureTemplateVersion: ORIGINAL_TEMPLATE_VERSION },
      );
      result.filled++;
    } catch (err) {
      result.unverifiable.push({
        slug: topic.slug,
        mode,
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  console.log(
    `[wiki/backfill] repo=${repo} branch=${branch} checked=${result.checked} filled=${result.filled} unverifiable=${result.unverifiable.length}`,
  );
  for (const u of result.unverifiable) {
    console.log(`[wiki/backfill]   unverifiable ${u.slug} (${u.mode}): ${u.reason}`);
  }
  return result;
}

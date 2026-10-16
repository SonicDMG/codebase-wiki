/**
 * sync.ts — Diff-driven incremental sync of stored wiki topics.
 *
 *   ensureTopics(branch)  — stored topics + snapshot, or initial generation.
 *   syncBranch(branch)    — checks branch head (conditional ETag), diffs the stored
 *                           snapshot against the new commit tree and updates the
 *                           snapshot/topics without any LLM calls. Added files that
 *                           match no topic scope are queued in `unclassifiedPaths`
 *                           (classified in a later phase).
 */

import { getBranchHead, getFileTreeResult } from '@/lib/github';
import { decodeFileList, diffSnapshots, encodeFileList } from './snapshot';
import { findEmptyTopicIds, pathMatchesScope } from './scope';
import {
  acquireLease,
  deleteTopicsByIds,
  getSnapshot,
  getStoredTopics,
  releaseLease,
  saveSnapshot,
  saveTopics,
  deleteTopicsForBranch,
} from './store';
import { buildSnapshotDoc, generateTopics, REPO_NAME, REPO_OWNER } from './generate';
import type { SnapshotEntry, SyncOutcome, WikiSnapshotDoc, WikiTopicDoc } from './types';

const CATCH_ALL_SLUG = 'repo-config-tooling';

/** Public topic shape consumed by the /wiki page. */
export interface PublicTopic {
  title: string;
  description: string;
  suggestedQuery: string;
  slug: string;
}

export function toPublicTopics(topics: WikiTopicDoc[]): PublicTopic[] {
  return topics.map((t) => ({
    title: t.title,
    description: t.description,
    suggestedQuery: t.suggestedQuery,
    slug: t.slug,
  }));
}

// ── ensureTopics ──────────────────────────────────────────────────────────────

/**
 * Returns stored topics + snapshot for a branch. If either is missing,
 * runs initial generation and persists the result.
 */
export async function ensureTopics(
  branch: string,
): Promise<{ topics: WikiTopicDoc[]; snapshot: WikiSnapshotDoc; generated: boolean }> {
  let hadTopics = false;
  try {
    const [stored, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
    if (stored.length > 0 && snapshot) {
      return { topics: stored, snapshot, generated: false };
    }
    hadTopics = stored.length > 0;
  } catch (err) {
    console.warn('[wiki] Astra read failed, will try generation:', err);
  }

  const { result, snapshotEntries, unclassifiedPaths, treeSha } = await generateTopics(branch);
  // Topics without a snapshot cannot be diffed — replace them wholesale.
  if (hadTopics) await deleteTopicsForBranch(branch);
  await saveTopics(result.topics);
  const snapshot = buildSnapshotDoc(branch, snapshotEntries, unclassifiedPaths, result.headSha, treeSha);
  await saveSnapshot(snapshot);
  console.log(`[wiki] generated and stored ${result.topics.length} topics for branch "${branch}"`);
  return { topics: result.topics, snapshot, generated: true };
}

// ── syncBranch ────────────────────────────────────────────────────────────────

function unmodified(topics: WikiTopicDoc[], headSha: string, branch: string): SyncOutcome {
  return { status: 'unmodified', headSha, branch, topics };
}

export async function syncBranch(branch: string): Promise<SyncOutcome> {
  const { topics: storedTopics, snapshot, generated } = await ensureTopics(branch);
  if (generated) return unmodified(storedTopics, snapshot.headSha, branch);

  // ── 1. Cheap head check (conditional request) ──────────────────────────────
  const head = await getBranchHead(REPO_OWNER, REPO_NAME, branch, snapshot.lastEtag);
  if (head.status === 'not-modified' || head.status === 'rate-limited') {
    return unmodified(storedTopics, snapshot.headSha, branch);
  }
  if (head.sha === snapshot.headSha) {
    // Same commit but a new/changed ETag — remember it so later checks return 304.
    if (head.etag && head.etag !== snapshot.lastEtag) {
      await saveSnapshot({ ...snapshot, lastEtag: head.etag, lastCheckedAt: new Date().toISOString() });
    }
    return unmodified(storedTopics, snapshot.headSha, branch);
  }

  // ── 2. Lease ───────────────────────────────────────────────────────────────
  if (!(await acquireLease(branch))) {
    return { status: 'locked', headSha: snapshot.headSha, branch, topics: storedTopics };
  }

  try {
    // Re-read under the lease: another sync may have completed since our first read.
    const [topics, base] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
    if (!base || topics.length === 0) return unmodified(storedTopics, snapshot.headSha, branch);
    if (base.headSha === head.sha) return unmodified(topics, base.headSha, branch);

    const now = new Date().toISOString();

    // Identical tree (e.g. empty / revert commit): just advance headSha.
    if (head.treeSha && head.treeSha === base.treeSha) {
      await saveSnapshot({ ...base, headSha: head.sha, lastEtag: head.etag, lastCheckedAt: now, leaseUntil: null });
      return unmodified(topics, head.sha, branch);
    }

    // ── 3. Diff ──────────────────────────────────────────────────────────────
    const tree = await getFileTreeResult(REPO_OWNER, REPO_NAME, head.sha);
    if (tree.truncated) {
      // A truncated tree would look like mass deletions — keep stored state.
      console.warn(`[wiki/sync] truncated tree for "${branch}" — skipping incremental sync`);
      return unmodified(topics, base.headSha, branch);
    }
    const newEntries: SnapshotEntry[] = tree.entries
      .filter((e) => e.type === 'blob')
      .map((e) => ({ sha: e.sha ?? '', path: e.path }));
    const newPaths = newEntries.map((e) => e.path);
    const diff = diffSnapshots(decodeFileList(base.fileListText), newEntries);

    // ── 4. Scope maintenance (titles/descriptions are never touched) ─────────
    const renameMap = new Map(diff.renames.map((r) => [r.oldPath, r.newPath]));
    const deleted = new Set(diff.deletions.map((d) => d.path));
    const changedTopics: WikiTopicDoc[] = [];
    let current = topics.map((t) => {
      const files = t.scope.files
        .map((f) => renameMap.get(f) ?? f)
        .filter((f) => !deleted.has(f));
      const same =
        files.length === t.scope.files.length && files.every((f, i) => f === t.scope.files[i]);
      if (same) return t;
      const next: WikiTopicDoc = { ...t, scope: { ...t.scope, files }, updatedAt: now };
      changedTopics.push(next);
      return next;
    });

    // Delete topics whose scope matches nothing (catch-all exempt).
    const emptyIds = new Set(
      findEmptyTopicIds(newPaths, new Map(current.map((t) => [t._id, t.scope]))).filter(
        (id) => current.find((t) => t._id === id)?.slug !== CATCH_ALL_SLUG,
      ),
    );
    const removedTitles = current.filter((t) => emptyIds.has(t._id)).map((t) => t.title);
    current = current.filter((t) => !emptyIds.has(t._id));
    const topicsToSave = changedTopics.filter((t) => !emptyIds.has(t._id));

    // ── 5. Absorb additions (zero LLM calls); queue the rest ─────────────────
    const pathSet = new Set(newPaths);
    const candidates = [
      ...base.unclassifiedPaths.map((p) => renameMap.get(p) ?? p),
      ...diff.additions.map((a) => a.path),
      ...diff.renames.map((r) => r.newPath),
    ];
    const unclassifiedPaths = [...new Set(candidates)].filter(
      (p) => pathSet.has(p) && !current.some((t) => pathMatchesScope(p, t.scope)),
    );
    const absorbed = diff.additions.filter((a) => !unclassifiedPaths.includes(a.path)).length;

    // ── 6. Persist ───────────────────────────────────────────────────────────
    await saveTopics(topicsToSave);
    await deleteTopicsByIds([...emptyIds]);
    await saveSnapshot({
      ...base,
      headSha: head.sha,
      treeSha: tree.treeSha || head.treeSha,
      fileListText: encodeFileList(newEntries),
      unclassifiedPaths,
      lastEtag: head.etag,
      lastCheckedAt: now,
      leaseUntil: null,
    });

    const parts = [
      diff.additions.length && `${diff.additions.length} added (${absorbed} absorbed)`,
      diff.modifications.length && `${diff.modifications.length} modified`,
      diff.renames.length && `${diff.renames.length} renamed`,
      diff.deletions.length && `${diff.deletions.length} removed`,
      removedTitles.length && `${removedTitles.length} topic${removedTitles.length === 1 ? '' : 's'} removed`,
      unclassifiedPaths.length && `${unclassifiedPaths.length} unclassified`,
    ].filter(Boolean);
    const changeSummary = parts.length > 0 ? parts.join(', ') : 'no file changes';
    console.log(`[wiki/sync] "${branch}" → ${head.sha.slice(0, 7)}: ${changeSummary}`);

    return { status: 'synced', headSha: head.sha, branch, topics: current, changeSummary };
  } finally {
    await releaseLease(branch).catch((err) => console.warn('[wiki/sync] lease release failed:', err));
  }
}

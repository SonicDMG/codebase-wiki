/**
 * sync.ts — Diff-driven incremental sync of stored wiki topics.
 *
 *   ensureTopics(branch)  — stored topics + snapshot, or initial generation.
 *   syncBranch(branch)    — checks branch head, diffs snapshot, absorbs matched
 *                           files, classifies unmatched via JEV, and runs
 *                           incremental LLM extension when the unclassified
 *                           threshold is crossed.
 */

import { getBranchHead, getFileTreeResult, isIgnoredPath } from '@/lib/github';
import { decodeFileList, diffSnapshots, encodeFileList } from './snapshot';
import { findEmptyTopicIds, pathMatchesScope, promoteDirectoryPrefixes } from './scope';
import {
  acquireLease,
  deleteTopicsByIds,
  getSnapshot,
  getStoredBranches,
  getStoredTopics,
  releaseLease,
  replaceTopics,
  saveSnapshot,
  saveTopics,
} from './store';
import { buildSnapshotDoc, extendTopics, generateTopics, REPO_NAME, REPO_OWNER, generatePagesForTopic, rebuildTopicPages } from './generate';
import { classifyFile } from './classify';
import { TOPIC_SECTIONS } from './types';
import type { SnapshotEntry, SyncOutcome, WikiSnapshotDoc, WikiTopicDoc } from './types';

const CATCH_ALL_SLUG = 'repo-config-tooling';

/** Public topic shape consumed by the /wiki page. */
export interface PublicTopic {
  title: string;
  description: string;
  suggestedQuery: string;
  slug: string;
  section?: string;
  generatedPage?: string;
  generatedPagePicture?: string;
  pageCommitSha?: string;
}

/** Topics grouped by section (stable — stored order is kept within a section). */
export function toPublicTopics(topics: WikiTopicDoc[]): PublicTopic[] {
  const rank = (t: WikiTopicDoc) => (t.section ? TOPIC_SECTIONS.indexOf(t.section) : TOPIC_SECTIONS.length);
  return [...topics].sort((a, b) => rank(a) - rank(b)).map((t) => ({
    title: t.title,
    description: t.description,
    suggestedQuery: t.suggestedQuery,
    slug: t.slug,
    section: t.section,
    generatedPage: t.generatedPage,
    generatedPagePicture: t.generatedPagePicture,
    pageCommitSha: t.pageCommitSha,
  }));
}

const seedingBranches = new Set<string>();

/**
 * In-flight initial generations, per branch. The wiki page fires /toc and
 * /sync together on load (twice in dev StrictMode); without this, each call
 * ran its own LLM generation and stored a separate topic set.
 */
const generating = new Map<string, Promise<{ topics: WikiTopicDoc[]; snapshot: WikiSnapshotDoc }>>();

async function generateAndStore(branch: string) {
  const { result, snapshotEntries, unclassifiedPaths, treeSha } = await generateTopics(branch);
  const allPaths = snapshotEntries.map((e) => e.path);
  const topicsWithPages = await rebuildTopicPages(result.topics, branch, result.headSha, allPaths);
  await replaceTopics(branch, topicsWithPages);
  const snapshot = buildSnapshotDoc(branch, snapshotEntries, unclassifiedPaths, result.headSha, treeSha);
  await saveSnapshot(snapshot);
  console.log(`[wiki] generated and stored ${topicsWithPages.length} topics for branch "${branch}"`);
  return { topics: topicsWithPages, snapshot };
}

// ── ensureTopics ──────────────────────────────────────────────────────────────

/**
 * Returns stored topics + snapshot for a branch. If either is missing,
 * attempts branch seeding from the nearest stored branch (e.g. main)
 * followed by an incremental sync against the branch head. If no stored
 * branches exist, runs initial generation and persists the result.
 */
export async function ensureTopics(
  branch: string,
): Promise<{ topics: WikiTopicDoc[]; snapshot: WikiSnapshotDoc; generated: boolean }> {
  try {
    const [stored, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
    if (stored.length > 0 && snapshot) {
      // Check if any topic lacks page content (due to older codebase wiki generation)
      const missingPages = stored.filter((t) => !t.generatedPage);
      if (missingPages.length > 0) {
        console.log(`[wiki] Stored topics found, but ${missingPages.length} topics are missing pre-generated pages. Starting background backfill...`);
        
        // Run backfilling completely asynchronously to keep TOC loading instant (takes < 5ms)
        void (async () => {
          try {
            const { entries } = await getFileTreeResult(REPO_OWNER, REPO_NAME, snapshot.headSha);
            const allPaths = entries.filter((e) => e.type === 'blob' && !isIgnoredPath(e.path)).map((e) => e.path);
            
            // Rebuild missing pages in parallel for speed!
            await Promise.all(
              missingPages.map(async (topic) => {
                try {
                  console.log(`[wiki] Background backfilling page content for topic "${topic.title}"...`);
                  const { wiki, picture } = await generatePagesForTopic(topic, branch, snapshot.headSha, allPaths);
                  topic.generatedPage = wiki;
                  topic.generatedPagePicture = picture;
                  topic.pageCommitSha = snapshot.headSha;
                  topic.updatedAt = new Date().toISOString();
                  await saveTopics([topic]);
                  console.log(`[wiki] Background backfill complete for topic "${topic.title}".`);
                } catch (err) {
                  console.error(`[wiki] Background backfill failed for topic "${topic.title}":`, err);
                }
              })
            );
            console.log(`[wiki] All missing pages backfilled successfully in the background.`);
          } catch (backfillErr) {
            console.error(`[wiki] Background automatic backfill of missing pages failed:`, backfillErr);
          }
        })();
      }
      return { topics: stored, snapshot, generated: false };
    }
  } catch (err) {
    console.warn('[wiki] Astra read failed, will try generation:', err);
  }

  // Branch seeding: when branch has no stored topics/snapshot, copy from nearest stored branch
  if (!seedingBranches.has(branch)) {
    seedingBranches.add(branch);
    try {
      const storedBranches = (await getStoredBranches()).filter((b) => b !== branch);
      const donor = storedBranches.includes('main') ? 'main' : storedBranches[0];
      if (donor) {
        const [donorTopics, donorSnapshot] = await Promise.all([
          getStoredTopics(donor),
          getSnapshot(donor),
        ]);
        if (donorTopics.length > 0 && donorSnapshot) {
          const now = new Date().toISOString();
          const seededTopics: WikiTopicDoc[] = donorTopics.map((t) => ({
            ...t,
            _id: `${branch}:${t.slug}`,
            branch,
          }));
          const seededSnapshot: WikiSnapshotDoc = {
            ...donorSnapshot,
            _id: `${branch}:snapshot`,
            branch,
            lastEtag: null,
            leaseUntil: null,
            lastCheckedAt: now,
          };
          await replaceTopics(branch, seededTopics);
          await saveSnapshot(seededSnapshot);
          console.log(`[wiki] seeded branch "${branch}" from "${donor}" (${seededTopics.length} topics)`);

          // Run syncBranch to diff against the new branch head
          try {
            const outcome = await syncBranch(branch);
            const finalSnapshot = (await getSnapshot(branch)) ?? seededSnapshot;
            return { topics: outcome.topics, snapshot: finalSnapshot, generated: false };
          } catch (syncErr) {
            console.warn(`[wiki] syncBranch after seeding failed for "${branch}", returning seeded topics:`, syncErr);
            return { topics: seededTopics, snapshot: seededSnapshot, generated: false };
          }
        }
      }
    } catch (seedErr) {
      console.warn('[wiki] branch seeding failed, falling back to full generation:', seedErr);
    } finally {
      seedingBranches.delete(branch);
    }
  }

  // Topics without a snapshot cannot be diffed — replace them wholesale.
  let pending = generating.get(branch);
  if (!pending) {
    pending = generateAndStore(branch).finally(() => generating.delete(branch));
    generating.set(branch, pending);
  }
  return { ...(await pending), generated: true };
}

// ── syncBranch ────────────────────────────────────────────────────────────────

function unmodified(
  topics: WikiTopicDoc[],
  headSha: string,
  branch: string,
  extra?: { rateLimited?: boolean; retryAfterSeconds?: number | null; warning?: string },
): SyncOutcome {
  return { status: 'unmodified', headSha, branch, topics, ...extra };
}

export async function syncBranch(branch: string): Promise<SyncOutcome> {
  const { topics: storedTopics, snapshot, generated } = await ensureTopics(branch);
  if (generated) return unmodified(storedTopics, snapshot.headSha, branch);

  // ── 1. Cheap head check (conditional request) ──────────────────────────────
  const head = await getBranchHead(REPO_OWNER, REPO_NAME, branch, snapshot.lastEtag);
  if (head.status === 'not-modified') {
    return unmodified(storedTopics, snapshot.headSha, branch);
  }
  if (head.status === 'rate-limited') {
    // Treat as no change — serve stored topics with a backoff hint.
    return unmodified(storedTopics, snapshot.headSha, branch, {
      rateLimited: true,
      retryAfterSeconds: head.retryAfterSeconds,
    });
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
      return unmodified(topics, base.headSha, branch, {
        warning: 'GitHub returned a truncated file tree — incremental sync skipped; stored topics served.',
      });
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

    // ── 5. Absorb additions that match existing scopes (zero LLM calls) ──────
    const pathSet = new Set(newPaths);
    const candidates = [
      ...base.unclassifiedPaths.map((p) => renameMap.get(p) ?? p),
      ...diff.additions.map((a) => a.path),
      ...diff.renames.map((r) => r.newPath),
    ];
    let unclassifiedPaths = [...new Set(candidates)].filter(
      (p) => pathSet.has(p) && !isIgnoredPath(p) && !current.some((t) => pathMatchesScope(p, t.scope)),
    );
    const absorbed = diff.additions.filter((a) => !unclassifiedPaths.includes(a.path)).length;

    // ── 6. JEV classification for each unclassified addition ─────────────────
    if (unclassifiedPaths.length > 0 && current.length > 0) {
      const stillUnclassified: string[] = [];
      const BATCH_SIZE = 8;
      const countBefore = unclassifiedPaths.length;
      for (let i = 0; i < unclassifiedPaths.length; i += BATCH_SIZE) {
        const batch = unclassifiedPaths.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (filePath) => {
            // Sibling context: up to 10 paths in the same directory.
            const dir = filePath.includes('/')
              ? filePath.slice(0, filePath.lastIndexOf('/') + 1)
              : '';
            const siblings = dir
              ? newPaths.filter((p) => p.startsWith(dir) && p !== filePath).slice(0, 10)
              : [];
            const chosenSlug = await classifyFile(filePath, siblings, current);
            if (!chosenSlug) {
              stillUnclassified.push(filePath);
              return;
            }
            const topicIdx = current.findIndex((t) => t.slug === chosenSlug);
            if (topicIdx < 0) {
              stillUnclassified.push(filePath);
              return;
            }
            // Add to topic's explicit files.
            const topic = current[topicIdx];
            if (!topic.scope.files.includes(filePath)) {
              current[topicIdx] = {
                ...topic,
                scope: { ...topic.scope, files: [...topic.scope.files, filePath] },
                updatedAt: now,
              };
              const saveIdx = topicsToSave.findIndex((ts) => ts._id === current[topicIdx]._id);
              if (saveIdx >= 0) {
                topicsToSave[saveIdx] = current[topicIdx];
              } else {
                topicsToSave.push(current[topicIdx]);
              }
            }
          }),
        );
      }
      const classifiedCount = countBefore - stillUnclassified.length;
      unclassifiedPaths = stillUnclassified;
      console.log(
        `[wiki/sync] JEV classified ${classifiedCount} paths; ${unclassifiedPaths.length} still unclassified`,
      );

      // Sibling promotion: if ≥3 newly classified files for the same topic share
      // a directory, promote that directory to a prefix in that topic's scope.
      for (let i = 0; i < current.length; i++) {
        const t = current[i];
        const newFiles = t.scope.files.filter((f) => candidates.includes(f) && !base.unclassifiedPaths.includes(f));
        if (newFiles.length < 3) continue;
        const maxCoverage = Math.floor(newPaths.length * 0.4);
        const promoted = promoteDirectoryPrefixes(newFiles).filter(
          (p) => !t.scope.prefixes.includes(p) && newPaths.filter((a) => a.startsWith(p)).length <= maxCoverage,
        );
        if (promoted.length > 0) {
          const filesToRemove = new Set(newFiles.filter((f) => promoted.some((pfx) => f.startsWith(pfx))));
          current[i] = {
            ...t,
            scope: {
              prefixes: [...t.scope.prefixes, ...promoted],
              files: t.scope.files.filter((f) => !filesToRemove.has(f)),
            },
            updatedAt: now,
          };
          const saveIdx = topicsToSave.findIndex((ts) => ts._id === current[i]._id);
          if (saveIdx >= 0) {
            topicsToSave[saveIdx] = current[i];
          } else {
            topicsToSave.push(current[i]);
          }
        }
      }
    }

    // ── 7. Incremental extension: ≥3 unclassified OR new top-level dir ────────
    const newTopLevelDirs = new Set(
      diff.additions
        .map((a) => (a.path.includes('/') ? a.path.split('/')[0] : null))
        .filter((d): d is string => d !== null),
    );
    const existingTopLevelDirs = new Set(
      decodeFileList(base.fileListText)
        .map((e) => (e.path.includes('/') ? e.path.split('/')[0] : null))
        .filter((d): d is string => d !== null),
    );
    const hasNewTopLevelDir = [...newTopLevelDirs].some((d) => !existingTopLevelDirs.has(d));

    if (unclassifiedPaths.length >= 3 || hasNewTopLevelDir) {
      try {
        const { updatedTopics, remainingUnclassified } = await extendTopics(
          branch,
          unclassifiedPaths,
          current,
          newPaths,
        );
        // Detect which topics changed and need saving.
        for (const updated of updatedTopics) {
          const orig = current.find((t) => t._id === updated._id);
          if (!orig || JSON.stringify(orig.scope) !== JSON.stringify(updated.scope)) {
            if (!topicsToSave.some((ts) => ts._id === updated._id)) topicsToSave.push(updated);
          }
        }
        // New topics not in current list.
        const currentIds = new Set(current.map((t) => t._id));
        for (const t of updatedTopics) {
          if (!currentIds.has(t._id)) topicsToSave.push(t);
        }
        current = updatedTopics;
        unclassifiedPaths = remainingUnclassified;
      } catch (err) {
        console.warn('[wiki/sync] incremental extension failed:', err);
      }
    }

    // Rebuild pages for affected or new topics on SHA change
    const changedPaths = [
      ...diff.additions.map((a) => a.path),
      ...diff.deletions.map((d) => d.path),
      ...diff.modifications.map((m) => m.path),
      ...diff.renames.map((r) => r.newPath),
      ...diff.renames.map((r) => r.oldPath),
    ];

    const topicsToRebuild = current.filter((topic) => {
      const isAffected = changedPaths.some((p) => pathMatchesScope(p, topic.scope));
      const hasNoPage = !topic.generatedPage;
      return isAffected || hasNoPage;
    });

    if (topicsToRebuild.length > 0) {
      console.log(`[wiki/sync] Rebuilding page content for ${topicsToRebuild.length} topics due to SHA/file changes...`);
      for (const topic of topicsToRebuild) {
        try {
          console.log(`[wiki/sync] Rebuilding page for topic "${topic.title}"...`);
          const { wiki, picture } = await generatePagesForTopic(topic, branch, head.sha, newPaths);
          topic.generatedPage = wiki;
          topic.generatedPagePicture = picture;
          topic.pageCommitSha = head.sha;
          topic.updatedAt = now;
          if (!topicsToSave.some((ts) => ts._id === topic._id)) {
            topicsToSave.push(topic);
          }
        } catch (err) {
          console.error(`[wiki/sync] Failed to rebuild page for topic "${topic.title}":`, err);
        }
      }
    }

    // ── 8. Persist ───────────────────────────────────────────────────────────
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

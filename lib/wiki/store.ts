/**
 * store.ts — Astra DB I/O for wiki topics and snapshots.
 *
 * Responsibilities:
 *   - Lazy creation of the `wiki_toc` collection (vector-enabled, same model/dimension
 *     as the rest of the repo).
 *   - CRUD for WikiTopicDoc and WikiSnapshotDoc.
 *   - 2-minute lease acquire/release on the snapshot document.
 *   - Tolerant of embedding ($vectorize) write failures — logs and continues.
 *
 * Imports the shared `getDb` handle from @walfly/db. Does NOT add any exports
 * to the db package; the wiki module is self-contained.
 */

import type { Collection } from '@datastax/astra-db-ts';
import { getDb } from '@walfly/db';
import { VECTOR_DIMENSION, VECTOR_MODEL, VECTORIZE_MAX_CHARS } from '@walfly/db';
import type { WikiTopicDoc, WikiSnapshotDoc, SyncResult, WikiJob, WikiJobSummary } from './types';

const WIKI_TOC_COLLECTION = 'wiki_toc';

/** 2-minute lease in milliseconds. */
const LEASE_DURATION_MS = 2 * 60 * 1000;

// ── Collection bootstrap ──────────────────────────────────────────────────────

let collectionEnsured = false;
let ensurePromise: Promise<void> | null = null;

/**
 * Lazily create the `wiki_toc` collection if it does not exist yet.
 * Safe to call concurrently — the promise is deduped.
 */
async function ensureWikiTocCollection(): Promise<Collection<WikiTopicDoc | WikiSnapshotDoc>> {
  const db = getDb();

  if (!collectionEnsured) {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        try {
          const collections = await db.listCollections();
          if (!collections.some((c) => c.name === WIKI_TOC_COLLECTION)) {
            console.log(`[wiki] lazy-creating "${WIKI_TOC_COLLECTION}" collection...`);
            await db.createCollection(WIKI_TOC_COLLECTION, {
              vector: {
                dimension: VECTOR_DIMENSION,
                metric: 'cosine',
                service: { provider: 'nvidia', modelName: VECTOR_MODEL },
              },
              // Deny indexing for the large text fields.
              indexing: {
                deny: ['fileListText', 'unclassifiedPaths'],
              },
            } as any);
            console.log(`[wiki] "${WIKI_TOC_COLLECTION}" collection created.`);
          }
          collectionEnsured = true;
        } catch (err: any) {
          if (
            err?.message?.includes('already exists') ||
            err?.code === 'COLLECTION_ALREADY_EXISTS'
          ) {
            collectionEnsured = true;
          } else {
            console.warn(`[wiki] notice while ensuring ${WIKI_TOC_COLLECTION}:`, err);
          }
        } finally {
          ensurePromise = null;
        }
      })();
    }
    await ensurePromise;
  }

  return db.collection<WikiTopicDoc | WikiSnapshotDoc>(WIKI_TOC_COLLECTION);
}

// ── Topic reads ───────────────────────────────────────────────────────────────

/**
 * Load all topic documents for a branch, sorted by `order` ascending.
 * Returns an empty array when none are found.
 */
export async function getStoredTopics(branch: string): Promise<WikiTopicDoc[]> {
  const col = await ensureWikiTocCollection();
  const cursor = col.find({ kind: 'topic', branch } as any);
  const docs: WikiTopicDoc[] = [];
  for await (const doc of cursor) {
    docs.push(doc as unknown as WikiTopicDoc);
  }
  docs.sort((a, b) => a.order - b.order);
  return docs;
}

// ── Snapshot reads/writes ─────────────────────────────────────────────────────

/** Load the snapshot document for a branch, or null if none exists. */
export async function getSnapshot(branch: string): Promise<WikiSnapshotDoc | null> {
  const col = await ensureWikiTocCollection();
  const id = `${branch}:snapshot`;
  const doc = await col.findOne({ _id: id } as any);
  return doc ? (doc as unknown as WikiSnapshotDoc) : null;
}

// ── Topic writes ──────────────────────────────────────────────────────────────

/**
 * Persist a full set of topics for a branch (upsert by _id).
 * Embedding failures are swallowed — we log and continue so a vectorize
 * outage never blocks the wiki.
 */
export async function saveTopics(topics: WikiTopicDoc[]): Promise<void> {
  if (topics.length === 0) return;
  const col = await ensureWikiTocCollection();

  // Write each topic individually so one bad $vectorize doesn't kill the batch.
  for (const topic of topics) {
    const doc: WikiTopicDoc = {
      ...topic,
      $vectorize: (topic.title + ' ' + topic.description).slice(0, VECTORIZE_MAX_CHARS),
    };
    try {
      await col.findOneAndReplace({ _id: doc._id } as any, doc as any, {
        upsert: true,
        returnDocument: 'after',
      });
    } catch (err) {
      console.warn(`[wiki] failed to upsert topic "${topic._id}":`, err);
      // Retry without $vectorize in case the embedding service is down.
      try {
        const { $vectorize: _v, ...docWithoutVector } = doc;
        await col.findOneAndReplace({ _id: doc._id } as any, docWithoutVector as any, {
          upsert: true,
          returnDocument: 'after',
        });
        console.log(`[wiki] topic "${topic._id}" saved without vectorize (embedding outage?)`);
      } catch (err2) {
        console.error(`[wiki] topic "${topic._id}" save failed entirely:`, err2);
      }
    }
  }
}

/**
 * Set only the given fields on one topic document. Uses a targeted `$set`
 * (never a full replace) so a concurrent writer — e.g. a backfill running
 * alongside a sync — can't overwrite fields it didn't touch.
 */
export async function updateTopicFields(id: string, fields: Partial<WikiTopicDoc>): Promise<void> {
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length === 0) return;
  const col = await ensureWikiTocCollection();
  await col.updateOne({ _id: id } as any, { $set: set } as any);
}

/**
 * Return the set of branch names that have at least one stored snapshot.
 * Used by branch seeding in sync.ts to find a donor branch.
 */
export async function getStoredBranches(): Promise<string[]> {
  const col = await ensureWikiTocCollection();
  const cursor = col.find({ kind: 'snapshot' } as any, { projection: { branch: 1 } as any });
  const branches: string[] = [];
  for await (const doc of cursor) {
    const snap = doc as unknown as { branch?: string };
    if (snap.branch) branches.push(snap.branch);
  }
  return branches;
}

/**
 * Make `topics` the complete topic set for a branch: upsert them, then delete
 * every other topic stored for the branch. Writing before deleting means
 * readers never see an empty TOC, and a generation that overlaps another can't
 * leave both sets behind (slugs differ between generations, so upserts alone
 * would accumulate).
 */
export async function replaceTopics(branch: string, topics: WikiTopicDoc[]): Promise<void> {
  await saveTopics(topics);
  const col = await ensureWikiTocCollection();
  await col.deleteMany({ kind: 'topic', branch, _id: { $nin: topics.map((t) => t._id) } } as any);
}

/**
 * Delete all topic documents for a branch.
 */
export async function deleteTopicsForBranch(branch: string): Promise<void> {
  const col = await ensureWikiTocCollection();
  await col.deleteMany({ kind: 'topic', branch } as any);
}

/**
 * Delete specific topic documents by their Astra _id.
 */
export async function deleteTopicsByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const col = await ensureWikiTocCollection();
  for (const id of ids) {
    await col.deleteOne({ _id: id } as any);
  }
}

// ── Snapshot writes ───────────────────────────────────────────────────────────

/**
 * Upsert the snapshot document for a branch.
 *
 * Uses a targeted `$set` of every field EXCEPT `_id`, `job` and `recentJobs`
 * (never a full replace). Callers such as sync.ts pass a snapshot they read
 * earlier, so replacing would silently wipe job state written meanwhile by the
 * job runner. `updateOne` with `upsert: true` creates the document (with the
 * filter's `_id`) when it does not exist yet.
 */
export async function saveSnapshot(snapshot: WikiSnapshotDoc): Promise<void> {
  const col = await ensureWikiTocCollection();
  const { _id, job: _job, recentJobs: _recent, ...fields } = snapshot;
  // Snapshot is NOT vector-indexed — omit $vectorize entirely.
  await col.updateOne({ _id } as any, { $set: fields } as any, { upsert: true });
}

// ── Job state (on the snapshot document) ─────────────────────────────────────
//
// All job writes are targeted `$set`s on `job` / `job.<field>` / `recentJobs`,
// guarded by a filter on `job.id` / `job.status`, so that:
//   - a cancel flag written by the stop route is never overwritten by a runner
//     progress write (the runner writes progress via dotted paths only);
//   - a stale runner can't write into a newer job;
//   - nothing here creates a bogus partial `job` object.

const RECENT_JOBS_LIMIT = 10;

/** Create/replace the whole `job` object (only at job start). */
export async function updateSnapshotJob(branch: string, job: WikiJob): Promise<void> {
  const col = await ensureWikiTocCollection();
  await col.updateOne({ _id: `${branch}:snapshot` } as any, { $set: { job } } as any);
}

/**
 * Write individual job fields via dotted-path `$set` (e.g. `job.finished`).
 * Never touches `job.cancelRequested`. No-op when `job.id` doesn't match.
 */
export async function updateJobFields(
  branch: string,
  jobId: string,
  fields: Partial<Omit<WikiJob, 'id' | 'cancelRequested'>>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) set[`job.${k}`] = v;
  }
  if (Object.keys(set).length === 0) return;
  const col = await ensureWikiTocCollection();
  await col.updateOne({ _id: `${branch}:snapshot`, 'job.id': jobId } as any, { $set: set } as any);
}

/** Set only `job.cancelRequested` on the running job. Returns true if a running job was flagged. */
export async function requestJobCancel(branch: string): Promise<boolean> {
  const col = await ensureWikiTocCollection();
  const res = await col.updateOne(
    { _id: `${branch}:snapshot`, 'job.status': 'running' } as any,
    { $set: { 'job.cancelRequested': true } } as any,
  );
  return res.matchedCount > 0;
}

/** Prepend a finished-job summary to `recentJobs` (keeps the last 10). */
export async function appendRecentJob(branch: string, summary: WikiJobSummary): Promise<void> {
  const snap = await getSnapshot(branch);
  const recentJobs = [summary, ...(snap?.recentJobs ?? []).filter((j) => j.id !== summary.id)].slice(
    0,
    RECENT_JOBS_LIMIT,
  );
  const col = await ensureWikiTocCollection();
  await col.updateOne({ _id: `${branch}:snapshot` } as any, { $set: { recentJobs } } as any);
}

// ── Lease management ─────────────────────────────────────────────────────────

/**
 * Try to acquire a 2-minute sync lease on the branch snapshot.
 *
 * Returns true if acquired (the caller should proceed with sync).
 * Returns false if another process holds the lease — caller returns stored topics.
 *
 * Implementation: atomic findOneAndUpdate with a filter on leaseUntil.
 * Astra does not support compare-and-swap natively, so we do a findOne + conditional
 * replace — this is advisory (not hard-locked) which is fine per the PRD.
 */
export async function acquireLease(branch: string): Promise<boolean> {
  const now = Date.now();
  const snapshotId = `${branch}:snapshot`;
  const col = await ensureWikiTocCollection();

  const existing = await col.findOne({ _id: snapshotId } as any);
  if (!existing) {
    // No snapshot yet — no lease to contest.
    return true;
  }

  const snap = existing as unknown as WikiSnapshotDoc;
  if (snap.leaseUntil !== null && snap.leaseUntil > now) {
    // Active lease held by another process.
    return false;
  }

  // Acquire lease by writing leaseUntil.
  const leaseUntil = now + LEASE_DURATION_MS;
  await col.updateOne(
    { _id: snapshotId } as any,
    { $set: { leaseUntil } } as any,
  );
  return true;
}

/**
 * Release the sync lease for a branch (set leaseUntil to null).
 * Called after sync completes (success or failure).
 */
export async function releaseLease(branch: string): Promise<void> {
  const snapshotId = `${branch}:snapshot`;
  const col = await ensureWikiTocCollection();
  await col.updateOne(
    { _id: snapshotId } as any,
    { $set: { leaseUntil: null } } as any,
  );
}

// ── Combined save ─────────────────────────────────────────────────────────────

/**
 * Atomically persist topics + snapshot and release the lease.
 * This is the final write at the end of a successful generate/sync.
 */
export async function saveSyncResult(result: SyncResult, snapshot: WikiSnapshotDoc): Promise<void> {
  await saveTopics(result.topics);
  // Release lease by writing leaseUntil = null in the same snapshot upsert.
  const finalSnapshot: WikiSnapshotDoc = { ...snapshot, leaseUntil: null };
  await saveSnapshot(finalSnapshot);
}

/**
 * types.ts — shared data shapes for the wiki topic persistence layer.
 *
 * Two document kinds share the `wiki_toc` Astra collection:
 *   - topic:    one per topic per branch, vector-indexed on title+description.
 *   - snapshot: one per branch, not vector-indexed; tracks the file list and
 *               the 2-minute sync lease.
 */

/** Directory-prefix + explicit-file scope for one topic. */
export interface TopicScope {
  /** Paths that must end with '/' — any file under the prefix belongs. */
  prefixes: string[];
  /** Exact file paths (no trailing slash). */
  files: string[];
}

/**
 * Astra document for a single wiki topic (kind = "topic").
 * _id format: `${branch}:${slug}`
 */
export interface WikiTopicDoc {
  _id: string;
  kind: 'topic';
  branch: string;
  slug: string;
  order: number;
  title: string;
  description: string;
  suggestedQuery: string;
  scope: TopicScope;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  /** $vectorize input — title + description, capped at ~750 chars. */
  $vectorize?: string;
}

/**
 * Astra document for the branch snapshot (kind = "snapshot").
 * _id format: `${branch}:snapshot`
 *
 * fileListText compact format: one line per file, `<blobSha> <path>\n`.
 */
export interface WikiSnapshotDoc {
  _id: string;
  kind: 'snapshot';
  branch: string;
  headSha: string;
  treeSha: string;
  /** Compact file list: `<blobSha> <path>\n` per file. */
  fileListText: string;
  /** Paths the last sync could not classify. */
  unclassifiedPaths: string[];
  /** ETag from last GitHub ref conditional request, or null. */
  lastEtag: string | null;
  /** Unix timestamp (ms) until which the sync lease is held. Null = no lease. */
  leaseUntil: number | null;
  lastCheckedAt: string; // ISO-8601
  lastRebuiltAt: string; // ISO-8601
}

/** One entry in the compact file list (decoded). */
export interface SnapshotEntry {
  sha: string;
  path: string;
}

/** Result of diffing two snapshots. */
export interface SnapshotDiff {
  /** Paths present in new but not old (by path). */
  additions: SnapshotEntry[];
  /** Paths present in old but not new (by path). */
  deletions: SnapshotEntry[];
  /** Same blob SHA, different path (rename/move). */
  renames: Array<{ oldPath: string; newPath: string; sha: string }>;
  /** Same path, different blob SHA (content modified). */
  modifications: SnapshotEntry[];
}

/** Return value of a sync/generate operation used by the toc route. */
export interface SyncResult {
  topics: WikiTopicDoc[];
  headSha: string;
  branch: string;
}

/** Return value of an incremental sync (POST /api/wiki/sync). */
export interface SyncOutcome extends SyncResult {
  status: 'synced' | 'unmodified' | 'locked';
  /** Human-readable summary of what changed (only for status 'synced'). */
  changeSummary?: string;
}

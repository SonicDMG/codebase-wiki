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

/** Nav groups, in display order. */
export const TOPIC_SECTIONS = ['Start here', 'How it works', 'Codebase', 'Reference'] as const;
export type TopicSection = (typeof TOPIC_SECTIONS)[number];

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
  /** Nav group heading — one of TOPIC_SECTIONS. Absent on topics stored before sections existed. */
  section?: TopicSection;
  scope: TopicScope;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  /** $vectorize input — title + description, capped at ~750 chars. */
  $vectorize?: string;
  /** Pre-generated wiki page content in markdown format. */
  generatedPage?: string;
  /** Pre-generated Field Guide page (```picture cards) for the topic. */
  generatedPagePicture?: string;
  /** The commit SHA at which this page content was generated. */
  pageCommitSha?: string;
  /**
   * Fingerprint for the Wiki page — a hash of the blob SHAs for files matched
   * by this topic's scope at generation time. Written alongside generatedPage.
   */
  pageFingerprint?: string;
  /** Template version used when generatedPage was produced. */
  pageTemplateVersion?: number;
  /**
   * Fingerprint for the Field Guide page — a hash of the blob SHAs for files
   * matched by this topic's scope at generation time. Written alongside
   * generatedPagePicture.
   */
  pagePictureFingerprint?: string;
  /** Template version used when generatedPagePicture was produced. */
  pagePictureTemplateVersion?: number;
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
  /**
   * Current or latest background job. Written ONLY through the targeted `$set`
   * helpers in store.ts — never by saveSnapshot (which preserves it).
   */
  job?: WikiJob;
  /** Summaries of the last 10 finished jobs, newest first. */
  recentJobs?: WikiJobSummary[];
}

// ── Background jobs ───────────────────────────────────────────────────────────

export type WikiJobStatus = 'running' | 'completed' | 'completed-with-errors' | 'cancelled' | 'failed';

/** What a job was asked to do. */
export type WikiJobRequest =
  | { kind: 'refresh-stale' }
  | { kind: 'refresh-field-guide'; onlyStale?: boolean }
  | { kind: 'refresh-page'; slug: string; mode: 'wiki' | 'picture' }
  | { kind: 'rebuild' }
  | { kind: 'integrity-check' };
export type WikiJobKind = WikiJobRequest['kind'];

/** One step of a job; the runner loops over stages in order. */
export type WikiJobStage =
  | { kind: 'refresh-pages' }
  | { kind: 'rebuild' }
  | { kind: 'integrity-check' };

/** One page-level problem found by an integrity check. */
export interface IntegrityProblem {
  slug: string;
  mode: 'wiki' | 'picture';
  reason: string;
}

/** One per-topic failure (old page kept). */
export interface WikiJobFailure {
  slug: string;
  modes: Array<'wiki' | 'picture'>;
  error: string;
}

export interface WikiJob {
  id: string;
  kind: WikiJobKind;
  status: WikiJobStatus;
  stages: WikiJobStage[];
  /** Topics to process. */
  total: number;
  /** Topics finished (succeeded + failed). */
  finished: number;
  succeeded: number;
  failures: WikiJobFailure[];
  /** Slugs of topics currently in flight. */
  currentSlugs: string[];
  startedAt: string; // ISO-8601
  finishedAt?: string; // ISO-8601
  heartbeatAt: string; // ISO-8601
  cancelRequested?: boolean;
  /** The original request that created this job (written at start for all kinds). */
  request?: WikiJobRequest;
  /** Slugs whose topics have finished (succeeded OR failed); used for resume. */
  doneSlugs?: string[];
  /** Result of an 'integrity-check' job (written with the final status). */
  integrity?: { checkedAt: string; problems: IntegrityProblem[] };
}

export interface WikiJobSummary {
  id: string;
  kind: WikiJobKind;
  status: WikiJobStatus;
  total: number;
  finished: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
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
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  warning?: string;
}

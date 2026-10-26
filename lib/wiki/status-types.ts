/**
 * status-types.ts — response shape of GET /api/wiki/status.
 * Type-only, so client code can `import type` it without pulling in server modules.
 */
import type { WikiJob, WikiJobSummary } from './types';



export type StalenessState = 'current' | 'files-changed' | 'older-template' | 'missing-or-failed';

export interface StatusEntry {
  state: StalenessState;
  reason: string;
}

export type StateCounts = Record<StalenessState, number>;

export interface WikiStatusTopic {
  slug: string;
  title: string;
  wiki: StatusEntry;
  picture: StatusEntry;
  updatedAt?: string;
}

export interface WikiStatusResponse {
  /** Current or latest job on this branch, or null. */
  job: WikiJob | null;
  /** True when job.status==='running' but the heartbeat is stale (>30 s). */
  interrupted: boolean;
  /** Last (up to 10) finished jobs, newest first. */
  recentJobs: WikiJobSummary[];
  /** Repo as "owner/name". */
  repo: string;
  branch: string;
  headSha: string;
  /** Current prompt template version of each mode. */
  templateVersion: { wiki: number; picture: number };
  counts: { wiki: StateCounts; picture: StateCounts };
  /** Present only on the read that ran the one-time fingerprint backfill. */
  backfill?: { filled: number; unverifiable: number };
  topics: WikiStatusTopic[];
}

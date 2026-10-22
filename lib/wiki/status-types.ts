/**
 * status-types.ts — response shape of GET /api/wiki/status.
 * Type-only, so client code can `import type` it without pulling in server modules.
 */

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
}

export interface WikiStatusResponse {
  branch: string;
  headSha: string;
  templateVersion: number;
  counts: { wiki: StateCounts; picture: StateCounts };
  topics: WikiStatusTopic[];
}

/**
 * fingerprint.ts — compute a content fingerprint for a topic's scope.
 *
 * The fingerprint is a SHA-256 hash over the sorted blob SHAs of every file
 * matched by the topic's scope (excluding ignored paths). A different head
 * commit alone does NOT change the fingerprint — only changed file contents do.
 */

import { createHash } from 'crypto';
import { isIgnoredPath } from '@/lib/github';
import { pathMatchesScope } from './scope';
import type { SnapshotEntry, TopicScope } from './types';

/**
 * Compute a deterministic fingerprint for a topic's scope against the given
 * snapshot entries. Returns a 12-char hex prefix of the SHA-256.
 *
 * @param scope   - The topic's scope (prefixes + explicit files).
 * @param entries - All snapshot entries (path + blobSha) for the branch.
 */
export function computeFingerprint(scope: TopicScope, entries: SnapshotEntry[]): string {
  // Collect matched, non-ignored blob SHAs, sorted by path for determinism.
  const matched = entries
    .filter((e) => !isIgnoredPath(e.path) && pathMatchesScope(e.path, scope))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (matched.length === 0) {
    return 'empty';
  }

  const hash = createHash('sha256');
  for (const e of matched) {
    // Hash path+sha so a rename (same content, different path) also changes fingerprint.
    hash.update(`${e.path}\0${e.sha}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Build a path→sha lookup from snapshot entries for use in staleness checks.
 */
export function buildShaMap(entries: SnapshotEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(e.path, e.sha);
  }
  return map;
}

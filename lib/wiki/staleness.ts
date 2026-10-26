/**
 * staleness.ts — pure classifier for a topic page's staleness state.
 *
 * Returns one of four states:
 *   'current'           — fingerprint and template version both match.
 *   'files-changed'     — fingerprint differs (files in scope changed content).
 *   'older-template'    — template version differs from the mode's TEMPLATE_VERSIONS entry.
 *   'missing-or-failed' — page is absent, empty, or (picture) has no valid cards.
 *
 * A different head commit alone is NOT stale (fingerprints are content-based).
 */

import { TEMPLATE_VERSIONS } from './prompts';
import { computeFingerprint } from './fingerprint';
import type { SnapshotEntry, WikiTopicDoc } from './types';

import type { StalenessState } from './status-types';
export type { StalenessState };
export type PageMode = 'wiki' | 'picture';

export interface StalenessResult {
  state: StalenessState;
  reason: string;
}

/** True when a picture page has at least one parseable ```picture card. */
export function hasPictureCards(page: string): boolean {
  const cards = [...page.matchAll(/```picture\n([\s\S]*?)(?:```|$)/g)];
  return cards.some(([, source]) => {
    try { JSON.parse(source); return true; } catch { return false; }
  });
}

/**
 * Pure staleness classifier.
 *
 * @param topic   - The stored topic doc.
 * @param mode    - Which page to classify ('wiki' or 'picture').
 * @param entries - Current snapshot entries for the branch (path + blobSha).
 */
export function classifyStaleness(
  topic: WikiTopicDoc,
  mode: PageMode,
  entries: SnapshotEntry[],
): StalenessResult {
  const isWiki = mode === 'wiki';
  const page = isWiki ? topic.generatedPage : topic.generatedPagePicture;
  const storedFingerprint = isWiki ? topic.pageFingerprint : topic.pagePictureFingerprint;
  const storedTemplateVersion = isWiki ? topic.pageTemplateVersion : topic.pagePictureTemplateVersion;

  // 1. Missing or empty page.
  if (!page || page.trim().length === 0) {
    return { state: 'missing-or-failed', reason: 'page not generated yet' };
  }

  // 2. Picture mode: check for valid cards.
  if (!isWiki && !hasPictureCards(page)) {
    return { state: 'missing-or-failed', reason: 'picture page has no valid cards' };
  }

  // 3. No stored fingerprint — must classify as missing-or-failed (pre-Phase-1 data).
  if (!storedFingerprint) {
    return { state: 'missing-or-failed', reason: 'no fingerprint yet (pre-backfill)' };
  }

  // 4. Template version mismatch.
  const currentTemplateVersion = TEMPLATE_VERSIONS[mode];
  if (storedTemplateVersion !== currentTemplateVersion) {
    return {
      state: 'older-template',
      reason: `generated with template v${storedTemplateVersion ?? '?'}, current is v${currentTemplateVersion}`,
    };
  }

  // 5. Fingerprint mismatch (files in scope changed).
  const currentFingerprint = computeFingerprint(topic.scope, entries);
  if (storedFingerprint !== currentFingerprint) {
    return {
      state: 'files-changed',
      reason: `scope files changed (stored ${storedFingerprint}, current ${currentFingerprint})`,
    };
  }

  // 6. All checks pass.
  return { state: 'current', reason: 'up to date' };
}

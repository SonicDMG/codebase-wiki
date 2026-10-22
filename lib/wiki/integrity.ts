/**
 * integrity.ts — pure per-topic integrity check (no I/O, no LLM).
 *
 * Reports, per page mode, pages that are missing, empty, placeholders,
 * Field Guide pages without valid cards, or have no recorded fingerprint /
 * template version (so they cannot be matched to their sources).
 */

import { FETCH_FAILED_PAGE, NO_SOURCE_FILES_PAGE } from './generate';
import { hasPictureCards } from './staleness';
import type { IntegrityProblem, WikiTopicDoc } from './types';

export function checkTopicIntegrity(topic: WikiTopicDoc): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];

  for (const mode of ['wiki', 'picture'] as const) {
    const isWiki = mode === 'wiki';
    const page = isWiki ? topic.generatedPage : topic.generatedPagePicture;
    const fingerprint = isWiki ? topic.pageFingerprint : topic.pagePictureFingerprint;
    const templateVersion = isWiki ? topic.pageTemplateVersion : topic.pagePictureTemplateVersion;
    const add = (reason: string) => problems.push({ slug: topic.slug, mode, reason });

    if (page === undefined || page === null) {
      add('page is missing');
      continue;
    }
    const trimmed = page.trim();
    if (trimmed.length === 0) {
      add('page is empty');
      continue;
    }
    if (trimmed === NO_SOURCE_FILES_PAGE || trimmed === FETCH_FAILED_PAGE) {
      add('page is a placeholder');
      continue;
    }
    if (!isWiki && !hasPictureCards(page)) add('Field Guide page has no valid cards');
    if (!fingerprint) add('no fingerprint recorded');
    if (templateVersion === undefined || templateVersion === null) add('no template version recorded');
  }

  return problems;
}

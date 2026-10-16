/**
 * validate.ts — PURE generation repair.
 *
 * No I/O. Takes a raw array of LLM-generated topics (with scopes) and the
 * current set of repository paths, and returns a cleaned array ready to store.
 *
 * Rules applied (in order):
 *   1. Drop topics whose scope matches zero files in the tree.
 *   2. Reject (widen) any single prefix that covers more than 40% of the tree —
 *      too broad a prefix is likely a hallucination or over-generalisation.
 *      When rejected, the prefix is removed from the scope; explicit files keep.
 *   3. Ensure exactly one catch-all "Repo Config & Tooling" topic exists.
 *      If none was generated, inject a minimal one.
 *   4. Re-order topics by their existing order field.
 */

import type { TopicScope, WikiTopicDoc } from './types';
import { isScopeEmpty, pathMatchesScope } from './scope';

const CATCH_ALL_TITLE = 'Repo Config & Tooling';
const CATCH_ALL_SLUG = 'repo-config-tooling';

/** Max fraction of tree a single prefix may cover before it is rejected. */
const MAX_PREFIX_FRACTION = 0.4;

/**
 * Given a prefix (ends with '/') and all repo paths, count how many paths
 * fall under it.
 */
function prefixCoverage(prefix: string, allPaths: string[]): number {
  return allPaths.filter((p) => p.startsWith(prefix)).length;
}

/**
 * Repair scope: remove prefixes that are over-broad (>40% of tree).
 * Explicit files are untouched.
 */
function repairScope(scope: TopicScope, allPaths: string[]): TopicScope {
  if (allPaths.length === 0) return scope;
  const threshold = Math.floor(allPaths.length * MAX_PREFIX_FRACTION);
  const keptPrefixes = scope.prefixes.filter(
    (prefix) => prefixCoverage(prefix, allPaths) <= threshold,
  );
  return { prefixes: keptPrefixes, files: scope.files };
}

/**
 * Repair a raw array of generated topics against the current file tree.
 *
 * `allPaths` should be the filtered (excluded files removed) paths from the
 * snapshot, i.e. the same set you build the snapshot from.
 *
 * Returns the repaired topic array with sequential order fields.
 */
export function repairGeneratedTopics(
  rawTopics: WikiTopicDoc[],
  allPaths: string[],
  branch: string,
): WikiTopicDoc[] {
  const now = new Date().toISOString();
  const result: WikiTopicDoc[] = [];
  let hasCatchAll = false;

  for (const topic of rawTopics) {
    // Rule 2: repair over-broad prefixes.
    const repairedScope = repairScope(topic.scope, allPaths);
    const repairedTopic: WikiTopicDoc = { ...topic, scope: repairedScope };

    // Rule 1: drop if scope now matches nothing.
    if (isScopeEmpty(allPaths, repairedScope)) {
      console.log(`[wiki] repairGeneratedTopics: dropping empty topic "${topic.title}"`);
      continue;
    }

    if (
      topic.slug === CATCH_ALL_SLUG ||
      topic.title.toLowerCase().includes('repo config') ||
      topic.title.toLowerCase().includes('tooling')
    ) {
      hasCatchAll = true;
    }

    result.push(repairedTopic);
  }

  // Rule 3: inject catch-all if absent.
  if (!hasCatchAll) {
    const catchAllScope: TopicScope = {
      prefixes: [],
      files: allPaths.filter(
        (p) =>
          !p.includes('/') || // root-level files
          p.startsWith('.github/') ||
          p.startsWith('.husky/') ||
          p.endsWith('.json') ||
          p.endsWith('.yaml') ||
          p.endsWith('.yml') ||
          p.endsWith('.env') ||
          p.endsWith('.env.example') ||
          p.endsWith('.gitignore') ||
          p.endsWith('.eslintrc') ||
          p.endsWith('.prettierrc'),
      ),
    };

    const catchAllDoc: WikiTopicDoc = {
      _id: `${branch}:${CATCH_ALL_SLUG}`,
      kind: 'topic',
      branch,
      slug: CATCH_ALL_SLUG,
      order: result.length,
      title: CATCH_ALL_TITLE,
      description:
        'Root-level configuration files, tooling setup, CI/CD workflows, and repository conventions.',
      suggestedQuery: 'How is this repository configured and what tooling does it use?',
      scope: catchAllScope,
      createdAt: now,
      updatedAt: now,
      $vectorize: `${CATCH_ALL_TITLE} Root-level configuration files, tooling setup, CI/CD workflows, and repository conventions.`.slice(0, 750),
    };

    // Only add if it covers at least one file.
    if (!isScopeEmpty(allPaths, catchAllScope)) {
      result.push(catchAllDoc);
    }
  }

  // Rule 4: re-index order fields sequentially.
  return result.map((t, i) => ({ ...t, order: i }));
}

/**
 * Returns the subset of `allPaths` that are not covered by any topic scope.
 * Used to seed `unclassifiedPaths` in the snapshot after initial generation.
 */
export function findUnclassifiedPaths(
  allPaths: string[],
  topics: WikiTopicDoc[],
): string[] {
  return allPaths.filter(
    (p) => !topics.some((t) => pathMatchesScope(p, t.scope)),
  );
}

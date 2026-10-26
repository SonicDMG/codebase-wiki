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
 *   3. Drop topics that repeat an earlier topic's title or question.
 *   4. Ensure exactly one catch-all "Repo Config & Tooling" topic exists
 *      (injecting one if needed), and give it every config file no other
 *      topic claimed — otherwise those files sit unclassified and trigger an
 *      LLM topic extension on every sync.
 *   5. Re-order topics by their existing order field.
 */

import { topicId } from './types';
import type { RepoKey, TopicScope, WikiTopicDoc } from './types';
import { isScopeEmpty, pathMatchesScope } from './scope';

const CATCH_ALL_TITLE = 'Repo Config & Tooling';
const CATCH_ALL_SLUG = 'repo-config-tooling';

/** Max fraction of tree a single prefix may cover before it is rejected. */
const MAX_PREFIX_FRACTION = 0.4;

/** Root-level files, CI and common config — what the catch-all topic owns. */
function isConfigPath(p: string): boolean {
  return (
    !p.includes('/') ||
    p.startsWith('.github/') ||
    p.startsWith('.husky/') ||
    p.endsWith('.json') ||
    p.endsWith('.yaml') ||
    p.endsWith('.yml') ||
    p.endsWith('.toml') ||
    p.endsWith('.env') ||
    p.endsWith('.env.example') ||
    p.endsWith('.gitignore') ||
    p.endsWith('.eslintrc') ||
    p.endsWith('.prettierrc') ||
    /\.config\.[cm]?[jt]s$/.test(p)
  );
}

/** Lowercase, punctuation-free form used to spot duplicate titles/questions. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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
  repo: RepoKey,
  branch: string,
): WikiTopicDoc[] {
  const now = new Date().toISOString();
  const result: WikiTopicDoc[] = [];
  const seenText = new Set<string>();

  for (const topic of rawTopics) {
    // Rule 3: drop duplicates of an earlier topic.
    const title = normalize(topic.title);
    const query = normalize(topic.suggestedQuery);
    if (seenText.has(title) || seenText.has(query)) {
      console.log(`[wiki] repairGeneratedTopics: dropping duplicate topic "${topic.title}"`);
      continue;
    }

    // Rule 2: repair over-broad prefixes.
    const repairedScope = repairScope(topic.scope, allPaths);
    const repairedTopic: WikiTopicDoc = { ...topic, scope: repairedScope };

    // Rule 1: drop if scope now matches nothing.
    if (isScopeEmpty(allPaths, repairedScope)) {
      console.log(`[wiki] repairGeneratedTopics: dropping empty topic "${topic.title}"`);
      continue;
    }

    seenText.add(title);
    seenText.add(query);
    result.push(repairedTopic);
  }

  // Rule 4: one catch-all, owning every config file nobody else claimed.
  const unclaimedConfig = findUnclassifiedPaths(allPaths, result).filter(isConfigPath);
  const catchAllIdx = result.findIndex((t) => t.slug === CATCH_ALL_SLUG);
  if (catchAllIdx >= 0) {
    const catchAll = result[catchAllIdx];
    result[catchAllIdx] = {
      ...catchAll,
      section: 'Reference',
      scope: { ...catchAll.scope, files: [...catchAll.scope.files, ...unclaimedConfig] },
    };
  } else if (unclaimedConfig.length > 0) {
    const description =
      'Root-level configuration files, tooling setup, CI/CD workflows, and repository conventions.';
    result.push({
      _id: topicId(repo, branch, CATCH_ALL_SLUG),
      kind: 'topic',
      repo,
      branch,
      slug: CATCH_ALL_SLUG,
      order: result.length,
      title: CATCH_ALL_TITLE,
      description,
      suggestedQuery: 'How is this repository configured and what tooling does it use?',
      section: 'Reference',
      scope: { prefixes: [], files: unclaimedConfig },
      createdAt: now,
      updatedAt: now,
    });
  }

  // Rule 5: re-index order fields sequentially.
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

/**
 * scope.ts — PURE path-to-scope matching, empty-topic detection,
 *            and directory-prefix promotion.
 *
 * No I/O. All functions operate on in-memory data.
 */

import type { TopicScope } from './types';

/**
 * Returns true if `path` belongs to `scope`.
 * A path matches if it equals an explicit file in scope.files, or if it
 * starts with one of the scope.prefixes (which must end with '/').
 */
export function pathMatchesScope(path: string, scope: TopicScope): boolean {
  if (scope.files.includes(path)) return true;
  for (const prefix of scope.prefixes) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Returns all paths from `allPaths` that belong to `scope`.
 */
export function filesForScope(allPaths: string[], scope: TopicScope): string[] {
  return allPaths.filter((p) => pathMatchesScope(p, scope));
}

/**
 * Returns true if none of `allPaths` are covered by `scope`.
 */
export function isScopeEmpty(allPaths: string[], scope: TopicScope): boolean {
  return filesForScope(allPaths, scope).length === 0;
}

/**
 * Given a list of file paths that all belong to the same topic, find any
 * common directory prefix that could replace individual explicit files.
 *
 * Rule: if 3 or more sibling files share the same direct-parent directory,
 * that directory path (with trailing '/') is eligible for promotion to a prefix.
 *
 * Returns an array of promoted prefix strings (e.g. `"packages/api/lib/wiki/"`).
 * The caller decides whether to add them to the scope.
 */
export function promoteDirectoryPrefixes(paths: string[]): string[] {
  const dirCount = new Map<string, number>();
  for (const p of paths) {
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash < 0) continue; // root-level file — no directory
    const dir = p.slice(0, lastSlash + 1); // includes trailing '/'
    dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
  }

  const promoted: string[] = [];
  for (const [dir, count] of dirCount) {
    if (count >= 3) promoted.push(dir);
  }
  return promoted;
}

/**
 * Find topic ids (from `topicScopeMap`) whose scope is empty against `allPaths`.
 */
export function findEmptyTopicIds(
  allPaths: string[],
  topicScopeMap: Map<string, TopicScope>,
): string[] {
  const empty: string[] = [];
  for (const [id, scope] of topicScopeMap) {
    if (isScopeEmpty(allPaths, scope)) empty.push(id);
  }
  return empty;
}

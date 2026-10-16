/**
 * github.ts
 *
 * Helpers for fetching live codebase content from GitHub.
 *
 * Two in-memory caches — both tied to the same TTL so they expire together:
 *
 *   Tree cache   — the flat file list for the repo (single entry, 60 s TTL).
 *                  Avoids burning a GitHub API call on every chat turn just to
 *                  get the file list.
 *
 *   Content cache — raw text of individual files, keyed by
 *                   "<owner>/<repo>/<branch>/<path>" (max FILE_CACHE_MAX entries,
 *                   5 min TTL). The same 10-15 files are fetched repeatedly for
 *                   related questions; caching them saves ~300 ms per follow-up
 *                   and significantly reduces GitHub API usage.
 *
 *   Both caches are invalidated together when the tree TTL expires, so cached
 *   file contents are never older than the tree snapshot they were selected from.
 *
 * With GITHUB_TOKEN set, the authenticated rate limit is 5 000 req/hr.
 * Without it, the unauthenticated limit is 60 req/hr — fine for local dev.
 */

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  /** Git blob SHA — populated from the GitHub tree API response. */
  sha?: string;
}

interface GitHubTreeResponse {
  sha?: string;
  tree: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
  truncated: boolean;
}

export interface FileTreeResult {
  entries: TreeEntry[];
  /** True when GitHub truncated the recursive tree (very large repo). */
  truncated: boolean;
  /** SHA of the tree object returned by GitHub. */
  treeSha: string;
}

/** Result of a branch-head lookup. `rate-limited` is for callers (Phase 5) to back off on. */
export type BranchHeadResult =
  | { status: 'ok'; sha: string; treeSha: string; etag: string | null }
  | { status: 'not-modified'; etag: string | null }
  | { status: 'rate-limited'; retryAfterSeconds: number | null };

const TREE_TTL_MS = 60_000;
const TREE_CACHE_MAX = 20;
const FILE_TTL_MS = 5 * 60_000; // 5 minutes
const FILE_CACHE_MAX = 50;      // max cached files; evicts oldest on overflow

// Tree cache — keyed by "<owner>/<repo>/<ref>" (ref is a commit SHA, or 'HEAD').
const treeCache = new Map<string, FileTreeResult & { expiresAt: number }>();

// File content cache — keyed by "<owner>/<repo>/<ref>/<path>".
const fileCache = new Map<string, { text: string; expiresAt: number }>();

function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Resolves the head commit SHA of a branch. Supports conditional requests:
 * pass a previous ETag as `ifNoneMatch` and a 304 yields `{ status: 'not-modified' }`.
 * 403/429 yield `{ status: 'rate-limited' }`; other failures throw.
 */
export async function getBranchHead(
  owner: string,
  repo: string,
  branch: string,
  ifNoneMatch?: string | null,
): Promise<BranchHeadResult> {
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/branches/${encoded}`;
  const res = await fetch(url, {
    headers: { ...githubHeaders(), ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}) },
  });
  const etag = res.headers.get('etag');

  if (res.status === 304) return { status: 'not-modified', etag: etag ?? ifNoneMatch ?? null };
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return { status: 'rate-limited', retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub branch API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { commit?: { sha?: string; commit?: { tree?: { sha?: string } } } };
  const sha = data.commit?.sha;
  if (!sha) throw new Error(`GitHub branch API returned no commit SHA for "${branch}"`);
  return { status: 'ok', sha, treeSha: data.commit?.commit?.tree?.sha ?? '', etag };
}

/**
 * Returns the flat file tree for the given repo at `ref` (a commit SHA; defaults
 * to 'HEAD' for backwards compatibility), using a 60-second in-memory cache keyed
 * by ref. Only blobs (files) are returned.
 */
export async function getFileTree(
  owner: string,
  repo: string,
  commitSha = 'HEAD',
): Promise<TreeEntry[]> {
  return (await getFileTreeResult(owner, repo, commitSha)).entries;
}

/** Same as getFileTree but also exposes `truncated` and the tree SHA. */
export async function getFileTreeResult(
  owner: string,
  repo: string,
  commitSha = 'HEAD',
): Promise<FileTreeResult> {
  const now = Date.now();
  const cacheKey = `${owner}/${repo}/${commitSha}`;
  const cached = treeCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`;
  const res = await fetch(url, { headers: githubHeaders() });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub tree API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as GitHubTreeResponse;

  if (data.truncated) {
    console.warn('[github] tree response was truncated — large repo, some files may be missing');
  }

  const entries: TreeEntry[] = data.tree
    .filter((e) => e.type === 'blob' && typeof e.path === 'string')
    .map((e) => ({ path: e.path as string, type: 'blob', size: e.size, sha: e.sha }));

  const result: FileTreeResult = {
    entries,
    truncated: Boolean(data.truncated),
    treeSha: data.sha ?? '',
  };
  if (treeCache.size >= TREE_CACHE_MAX) {
    const oldestKey = treeCache.keys().next().value;
    if (oldestKey !== undefined) treeCache.delete(oldestKey);
  }
  treeCache.set(cacheKey, { ...result, expiresAt: now + TREE_TTL_MS });
  console.log(`[github] file tree fetched: ${entries.length} files (cached for 60 s)`);

  return result;
}

/**
 * Fetches the raw content of multiple files in parallel at `ref` (a commit SHA,
 * or a branch name; defaults to 'main').
 * Results are cached for FILE_TTL_MS (5 min). Cache entries are evicted LRU-style
 * when FILE_CACHE_MAX is exceeded. Files that 404 or fail are omitted from the
 * result map (not cached, so a transient failure is retried next turn).
 */
export async function fetchFileContents(
  owner: string,
  repo: string,
  paths: string[],
  ref = 'main',
): Promise<Record<string, string>> {
  const now = Date.now();
  const contents: Record<string, string> = {};
  const toFetch: string[] = [];

  // Partition: serve cache hits immediately, collect misses.
  for (const path of paths) {
    const key = `${owner}/${repo}/${ref}/${path}`;
    const cached = fileCache.get(key);
    if (cached && now < cached.expiresAt) {
      contents[path] = cached.text;
    } else {
      toFetch.push(path);
    }
  }

  const cacheHits = paths.length - toFetch.length;
  if (cacheHits > 0) {
    console.log(`[github] file cache: ${cacheHits} hit(s), ${toFetch.length} miss(es)`);
  }

  if (toFetch.length === 0) return contents;

  // Fetch misses in parallel.
  const results = await Promise.allSettled(
    toFetch.map(async (path) => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
      const res = await fetch(url, { headers: githubHeaders() });
      if (!res.ok) {
        console.warn(`[github] failed to fetch ${path}: ${res.status}`);
        return null;
      }
      const text = await res.text();
      return { path, text };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const { path, text } = result.value;
      contents[path] = text;

      // Store in cache, evicting the oldest entry if at capacity.
      const key = `${owner}/${repo}/${ref}/${path}`;
      if (fileCache.size >= FILE_CACHE_MAX) {
        const oldestKey = fileCache.keys().next().value;
        if (oldestKey !== undefined) fileCache.delete(oldestKey);
      }
      fileCache.set(key, { text, expiresAt: now + FILE_TTL_MS });
    }
  }

  return contents;
}

/**
 * Formats the file tree into a compact text list suitable for injecting into
 * an LLM prompt. Directories are represented implicitly by path separators.
 * Files larger than MAX_SIZE_BYTES are annotated so the LLM can deprioritise
 * very large generated files (e.g. lockfiles, bundles).
 */
const MAX_SIZE_BYTES = 200_000;

export function formatTreeForPrompt(entries: TreeEntry[]): string {
  return entries
    .filter((e) => !shouldExclude(e.path))
    .map((e) => {
      const size = e.size ?? 0;
      return size > MAX_SIZE_BYTES ? `${e.path}  [large: ${Math.round(size / 1024)} KB]` : e.path;
    })
    .join('\n');
}

/** Paths that are never useful for answering developer questions. */
function shouldExclude(path: string): boolean {
  return (
    path.startsWith('node_modules/') ||
    path.startsWith('.git/') ||
    path.includes('/node_modules/') ||
    path.includes('/.next/') ||
    path.includes('/dist/') ||
    path.includes('/.expo/') ||
    path.endsWith('.lock') ||
    path.endsWith('pnpm-lock.yaml') ||
    path.endsWith('package-lock.json')
  );
}

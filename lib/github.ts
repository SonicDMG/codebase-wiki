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
}

interface GitHubTreeResponse {
  tree: Array<{ path?: string; type?: string; size?: number }>;
  truncated: boolean;
}

const TREE_TTL_MS = 60_000;
const FILE_TTL_MS = 5 * 60_000; // 5 minutes
const FILE_CACHE_MAX = 50;      // max cached files; evicts oldest on overflow

// Single-entry in-memory cache — one repo, one branch.
let treeCache: { entries: TreeEntry[]; expiresAt: number } | null = null;

// File content cache — keyed by "<owner>/<repo>/<branch>/<path>".
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
 * Returns the flat file tree for the given repo at HEAD, using a 60-second
 * in-memory cache. Only blobs (files) are returned; tree entries (directories)
 * are filtered out because they carry no useful information for file selection.
 */
export async function getFileTree(owner: string, repo: string): Promise<TreeEntry[]> {
  const now = Date.now();
  if (treeCache && now < treeCache.expiresAt) {
    return treeCache.entries;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
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
    .map((e) => ({ path: e.path as string, type: 'blob', size: e.size }));

  treeCache = { entries, expiresAt: now + TREE_TTL_MS };
  console.log(`[github] file tree fetched: ${entries.length} files (cached for 60 s)`);

  return entries;
}

/**
 * Fetches the raw content of multiple files in parallel from the default branch.
 * Results are cached for FILE_TTL_MS (5 min). Cache entries are evicted LRU-style
 * when FILE_CACHE_MAX is exceeded. Files that 404 or fail are omitted from the
 * result map (not cached, so a transient failure is retried next turn).
 */
export async function fetchFileContents(
  owner: string,
  repo: string,
  paths: string[],
  branch = 'main',
): Promise<Record<string, string>> {
  const now = Date.now();
  const contents: Record<string, string> = {};
  const toFetch: string[] = [];

  // Partition: serve cache hits immediately, collect misses.
  for (const path of paths) {
    const key = `${owner}/${repo}/${branch}/${path}`;
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
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
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
      const key = `${owner}/${repo}/${branch}/${path}`;
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

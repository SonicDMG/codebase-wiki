/**
 * github.ts
 *
 * Helpers for fetching live codebase content from GitHub.
 *
 * Two in-memory caches. Callers key them by commit SHA, so an entry is
 * immutable and a long TTL cannot serve stale content; the TTL only bounds
 * memory. It is deliberately much longer than one chat turn (streaming an
 * answer alone can take a minute), so a conversation never re-fetches.
 *
 *   Tree cache   — the flat file list per commit (TREE_CACHE_MAX entries,
 *                  30 min TTL). Avoids burning a GitHub API call on every chat
 *                  turn just to get the file list.
 *
 *   Content cache — raw text of individual files, keyed by
 *                   "<owner>/<repo>/<ref>/<path>" (max FILE_CACHE_MAX entries,
 *                   30 min TTL). The same 10-15 files are fetched repeatedly for
 *                   related questions; caching them saves ~300 ms per follow-up
 *                   and significantly reduces GitHub API usage.
 *
 *   If a caller passes a mutable ref (a branch name or 'HEAD') instead of a
 *   commit SHA, entries can be up to 30 min old. Pass the SHA.
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

const TREE_TTL_MS = 30 * 60_000; // 30 minutes
const TREE_CACHE_MAX = 20;
const FILE_TTL_MS = 30 * 60_000; // 30 minutes
const FILE_CACHE_MAX = 200;     // max cached files; evicts oldest on overflow (~15 files per question)

/** Short cache for branch lists — avoids burning calls on repeated branch-picker opens. */
const BRANCHES_TTL_MS = 30_000;
interface BranchListCache { branches: string[]; defaultBranch: string; expiresAt: number }
const branchesCache = new Map<string, BranchListCache>();

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
  console.log(`[github] file tree fetched: ${entries.length} files (cached for 30 min)`);

  return result;
}

/**
 * Fetches the raw content of multiple files in parallel at `ref` (a commit SHA,
 * or a branch name; defaults to 'main').
 * Results are cached for FILE_TTL_MS (30 min). Cache entries are evicted LRU-style
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
 * Returns the list of branches for a repo plus the repo's default branch.
 * Paginates up to 10 pages (300 branches) with a 30-second in-memory cache.
 */
export async function listBranches(
  owner: string,
  repo: string,
): Promise<{ branches: string[]; defaultBranch: string }> {
  const now = Date.now();
  const cacheKey = `${owner}/${repo}`;
  const cached = branchesCache.get(cacheKey);
  if (cached && now < cached.expiresAt) return { branches: cached.branches, defaultBranch: cached.defaultBranch };

  // Fetch default branch cheaply from the repo API.
  let defaultBranch = 'main';
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: githubHeaders() });
    if (repoRes.ok) {
      const repoData = (await repoRes.json()) as { default_branch?: string };
      if (repoData.default_branch) defaultBranch = repoData.default_branch;
    }
  } catch { /* ignore — fall back to 'main' */ }

  // Paginate branch list (30 per page, up to 10 pages = 300 branches).
  const branches: string[] = [];
  const PER_PAGE = 30;
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) break;
    const data = (await res.json()) as Array<{ name?: string }>;
    for (const b of data) {
      if (b.name) branches.push(b.name);
    }
    if (data.length < PER_PAGE) break; // last page
  }

  const result = { branches, defaultBranch };
  branchesCache.set(cacheKey, { ...result, expiresAt: now + BRANCHES_TTL_MS });
  return result;
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
    .filter((e) => !isIgnoredPath(e.path))
    .map((e) => {
      const size = e.size ?? 0;
      return size > MAX_SIZE_BYTES ? `${e.path}  [large: ${Math.round(size / 1024)} KB]` : e.path;
    })
    .join('\n');
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'svg',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'ttf', 'otf', 'woff', 'woff2', 'pdf', 'zip',
]);

/** Paths that are never useful for answering developer questions (or for wiki topics). */
export function isIgnoredPath(path: string): boolean {
  return (
    path.startsWith('node_modules/') ||
    path.startsWith('.git/') ||
    path.includes('/node_modules/') ||
    path.includes('/.next/') ||
    path.includes('/dist/') ||
    path.includes('/.expo/') ||
    path.endsWith('.lock') ||
    path.endsWith('pnpm-lock.yaml') ||
    path.endsWith('package-lock.json') ||
    // Agent/tool state, not project source.
    path.startsWith('.beads/') ||
    path.startsWith('.claude/') ||
    path.startsWith('.devin/') ||
    path.startsWith('.worktrees/') ||
    // Binary assets — nothing for the model to read.
    BINARY_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())
  );
}

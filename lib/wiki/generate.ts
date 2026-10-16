/**
 * generate.ts — Full initial topic generation + incremental extension via LLM.
 *
 * generateTopics(branch)  — Full generation from scratch.
 * extendTopics(branch, unclassifiedPaths, currentTopics, allPaths)
 *                         — Incremental call: creates new topics or extends
 *                           existing scopes for unclassified paths, without
 *                           rewriting existing topic titles/descriptions.
 */

import { getLlmModel, llmClient } from '@/lib/llm';
import { formatTreeForPrompt, getBranchHead, getFileTreeResult } from '@/lib/github';
import { repairGeneratedTopics, findUnclassifiedPaths } from './validate';
import { promoteDirectoryPrefixes, pathMatchesScope } from './scope';
import type { WikiTopicDoc, WikiSnapshotDoc, SnapshotEntry, SyncResult } from './types';
import { encodeFileList } from './snapshot';

export const REPO_OWNER = 'SonicDMG';
export const REPO_NAME = 'walfly';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Generate topics for a branch from scratch.
 * Fetches the file tree, calls the LLM, repairs the output, and returns
 * a SyncResult plus the snapshot data needed to persist it.
 */
export async function generateTopics(branch: string): Promise<{
  result: SyncResult;
  snapshotEntries: SnapshotEntry[];
  unclassifiedPaths: string[];
  treeSha: string;
}> {
  const client = llmClient();
  const model = getLlmModel();

  const head = await getBranchHead(REPO_OWNER, REPO_NAME, branch);
  if (head.status !== 'ok') {
    throw new Error(
      head.status === 'rate-limited'
        ? 'GitHub rate limit reached while resolving branch head'
        : `Could not resolve head of branch "${branch}"`,
    );
  }
  const { entries, treeSha } = await getFileTreeResult(REPO_OWNER, REPO_NAME, head.sha);
  const treeText = formatTreeForPrompt(entries);
  const allPaths = entries.filter((e) => e.type === 'blob').map((e) => e.path);

  console.log(`[wiki] generating topics for branch "${branch}" — ${allPaths.length} files`);

  const response = await client.chat.completions.create({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `You are a technical documentation assistant for the Walfly monorepo.
Given the file tree below, produce a developer wiki table of contents.

Output ONLY a JSON array of 10–14 topic objects with these fields:
  - "title": short section title (3–6 words, e.g. "Backend API Overview")
  - "description": one sentence describing what a developer will learn (max 120 chars)
  - "suggestedQuery": a natural-language question a developer would ask (max 100 chars)
  - "scope": an object with:
      - "prefixes": array of directory paths with trailing "/" that belong to this topic
        (e.g. ["packages/api/lib/", "packages/db/src/"]) — be narrow, not broad
      - "files": array of individual file paths that belong to this topic

Rules:
- Every file in the tree should be covered by at least one topic.
- No single prefix may cover more than 30% of all files — keep scopes narrow.
- The LAST topic in the array MUST have title "Repo Config & Tooling" with:
    slug: "repo-config-tooling"
    scope.prefixes: [] (no prefixes — too broad)
    scope.files: all root-level config files, .github/, CI/CD files, dotfiles, package.json files
- Order topics from high-level (architecture, getting started) to low-level (data, infra).
- No markdown fences, no prose — ONLY the raw JSON array.`,
      },
      {
        role: 'user',
        content: `File tree for ${REPO_OWNER}/${REPO_NAME} (branch: ${branch}):\n\n${treeText}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '[]';
  let rawTopics: Array<{
    title?: string;
    description?: string;
    suggestedQuery?: string;
    scope?: { prefixes?: string[]; files?: string[] };
  }> = [];

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) rawTopics = parsed;
  } catch {
    console.warn('[wiki] generate: JSON parse failed, raw:', raw.slice(0, 300));
  }

  const now = new Date().toISOString();

  // Map raw LLM output to WikiTopicDoc array.
  const mappedTopics: WikiTopicDoc[] = rawTopics
    .filter(
      (t) =>
        typeof t?.title === 'string' &&
        typeof t?.description === 'string' &&
        typeof t?.suggestedQuery === 'string',
    )
    .map((t, i) => {
      const title = String(t.title!).trim();
      const slug = slugify(title);
      return {
        _id: `${branch}:${slug}`,
        kind: 'topic' as const,
        branch,
        slug,
        order: i,
        title,
        description: String(t.description!).trim().slice(0, 150),
        suggestedQuery: String(t.suggestedQuery!).trim().slice(0, 120),
        scope: {
          prefixes: Array.isArray(t.scope?.prefixes)
            ? t.scope!.prefixes.filter((p): p is string => typeof p === 'string')
            : [],
          files: Array.isArray(t.scope?.files)
            ? t.scope!.files.filter((p): p is string => typeof p === 'string')
            : [],
        },
        createdAt: now,
        updatedAt: now,
      } satisfies WikiTopicDoc;
    });

  // Repair: drop empty scopes, reject over-broad prefixes, ensure catch-all.
  const repairedTopics = repairGeneratedTopics(mappedTopics, allPaths, branch);
  const unclassifiedPaths = findUnclassifiedPaths(allPaths, repairedTopics);

  if (unclassifiedPaths.length > 0) {
    console.log(
      `[wiki] ${unclassifiedPaths.length} paths unclassified after generation (will be classified in Phase 4)`,
    );
  }

  // Build snapshot entries with blob SHAs from the GitHub tree API.
  const snapshotEntries: SnapshotEntry[] = entries
    .filter((e) => e.type === 'blob')
    .map((e) => ({ sha: e.sha ?? '', path: e.path }));

  return {
    result: {
      topics: repairedTopics,
      headSha: head.sha,
      branch,
    },
    snapshotEntries,
    unclassifiedPaths,
    treeSha,
  };
}

// ── extendTopics ─────────────────────────────────────────────────────────────

/**
 * Incremental topic extension.
 *
 * Called when ≥3 files are unclassified OR a new top-level directory appears.
 * Sends only the unclassified paths + existing topic titles to the LLM and
 * asks it to either:
 *   (a) extend an existing topic's scope with new prefixes/files, or
 *   (b) create brand-new topic(s).
 *
 * Existing topic titles and descriptions are NEVER rewritten.
 *
 * Returns the updated topic list (may have new docs appended or existing ones
 * with extended scopes) plus the paths that remain unclassified after extension.
 */
export async function extendTopics(
  branch: string,
  unclassifiedPaths: string[],
  currentTopics: WikiTopicDoc[],
  allPaths: string[],
): Promise<{ updatedTopics: WikiTopicDoc[]; remainingUnclassified: string[] }> {
  if (unclassifiedPaths.length === 0) {
    return { updatedTopics: currentTopics, remainingUnclassified: [] };
  }

  const client = llmClient();
  const model = getLlmModel();

  const existingTitlesList = currentTopics
    .map((t, i) => `${i + 1}. slug="${t.slug}" title="${t.title}"`)
    .join('\n');

  console.log(
    `[wiki/extend] incremental extension for ${unclassifiedPaths.length} unclassified paths on branch "${branch}"`,
  );

  const response = await client.chat.completions.create({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `You are a technical documentation assistant for the Walfly monorepo.
You will be given a list of file paths that do not yet belong to any wiki topic.
You may either:
  (a) Assign each path to an EXISTING topic by returning an extension (add prefixes or files to its scope), OR
  (b) Create a NEW topic for a genuinely new area of the codebase.

IMPORTANT RULES:
- Do NOT rewrite, rename, or change the description of any existing topic.
- Only output topics that need to change (extensions) or new topics.
- Keep scopes narrow — no prefix covering more than 30% of all files.
- Output ONLY a JSON object with two keys:
    "extensions": array of { "slug": "<existing slug>", "newPrefixes": [...], "newFiles": [...] }
    "newTopics":  array of { "title": "...", "description": "...", "suggestedQuery": "...", "scope": { "prefixes": [...], "files": [...] } }
- No markdown fences, no prose.`,
      },
      {
        role: 'user',
        content: `Existing topics:\n${existingTitlesList}\n\nUnclassified paths to assign:\n${unclassifiedPaths.join('\n')}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '{}';
  let parsed: {
    extensions?: Array<{ slug: string; newPrefixes?: string[]; newFiles?: string[] }>;
    newTopics?: Array<{
      title?: string;
      description?: string;
      suggestedQuery?: string;
      scope?: { prefixes?: string[]; files?: string[] };
    }>;
  } = {};

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn('[wiki/extend] JSON parse failed, raw:', raw.slice(0, 300));
  }

  const now = new Date().toISOString();
  const updatedTopics: WikiTopicDoc[] = currentTopics.map((t) => ({ ...t }));

  // Apply extensions to existing topics (never touch title/description).
  const extensionSlugs = new Set<string>();
  for (const ext of parsed.extensions ?? []) {
    if (typeof ext.slug !== 'string') continue;
    const idx = updatedTopics.findIndex((t) => t.slug === ext.slug);
    if (idx < 0) continue;
    extensionSlugs.add(ext.slug);
    const topic = updatedTopics[idx];
    const addedPrefixes = (ext.newPrefixes ?? []).filter(
      (p): p is string => typeof p === 'string' && !topic.scope.prefixes.includes(p),
    );
    const addedFiles = (ext.newFiles ?? []).filter(
      (f): f is string => typeof f === 'string' && !topic.scope.files.includes(f),
    );
    if (addedPrefixes.length > 0 || addedFiles.length > 0) {
      updatedTopics[idx] = {
        ...topic,
        scope: {
          prefixes: [...topic.scope.prefixes, ...addedPrefixes],
          files: [...topic.scope.files, ...addedFiles],
        },
        updatedAt: now,
      };
    }
  }

  // Add new topics.
  const CATCH_ALL_SLUG = 'repo-config-tooling';
  let order = updatedTopics.length;
  for (const raw of parsed.newTopics ?? []) {
    if (typeof raw?.title !== 'string' || typeof raw?.description !== 'string') continue;
    const title = String(raw.title).trim();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    // Don't create duplicates or overwrite the catch-all.
    if (updatedTopics.some((t) => t.slug === slug) || slug === CATCH_ALL_SLUG) continue;
    const newTopic: WikiTopicDoc = {
      _id: `${branch}:${slug}`,
      kind: 'topic',
      branch,
      slug,
      order: order++,
      title,
      description: String(raw.description).trim().slice(0, 150),
      suggestedQuery: String(raw.suggestedQuery ?? '').trim().slice(0, 120),
      scope: {
        prefixes: Array.isArray(raw.scope?.prefixes)
          ? raw.scope!.prefixes.filter((p): p is string => typeof p === 'string')
          : [],
        files: Array.isArray(raw.scope?.files)
          ? raw.scope!.files.filter((f): f is string => typeof f === 'string')
          : [],
      },
      createdAt: now,
      updatedAt: now,
    };
    updatedTopics.push(newTopic);
  }

  // Apply broad-prefix guard from validate: drop over-broad prefixes (>40% tree).
  const MAX_PREFIX_FRACTION = 0.4;
  const threshold = Math.floor(allPaths.length * MAX_PREFIX_FRACTION);
  for (let i = 0; i < updatedTopics.length; i++) {
    const t = updatedTopics[i];
    const keptPrefixes = t.scope.prefixes.filter(
      (p) => allPaths.filter((a) => a.startsWith(p)).length <= threshold,
    );
    if (keptPrefixes.length !== t.scope.prefixes.length) {
      updatedTopics[i] = { ...t, scope: { ...t.scope, prefixes: keptPrefixes } };
    }
  }

  // Sibling directory promotion: for paths that landed in the same topic,
  // if ≥3 siblings share the same directory, promote to a prefix.
  for (let i = 0; i < updatedTopics.length; i++) {
    const t = updatedTopics[i];
    const newlyAssignedFiles = t.scope.files.filter((f) => unclassifiedPaths.includes(f));
    if (newlyAssignedFiles.length < 3) continue;
    const promoted = promoteDirectoryPrefixes(newlyAssignedFiles).filter(
      (p) => !t.scope.prefixes.includes(p) && allPaths.filter((a) => a.startsWith(p)).length <= threshold,
    );
    if (promoted.length > 0) {
      // Move those explicit files out of scope.files into a prefix.
      const filesToRemove = new Set(
        newlyAssignedFiles.filter((f) => promoted.some((pfx) => f.startsWith(pfx))),
      );
      updatedTopics[i] = {
        ...t,
        scope: {
          prefixes: [...t.scope.prefixes, ...promoted],
          files: t.scope.files.filter((f) => !filesToRemove.has(f)),
        },
        updatedAt: now,
      };
      console.log(`[wiki/extend] promoted ${promoted.join(', ')} → topic "${t.title}"`);
    }
  }

  // Determine which unclassified paths are now covered.
  const remainingUnclassified = unclassifiedPaths.filter(
    (p) => !updatedTopics.some((t) => pathMatchesScope(p, t.scope)),
  );

  console.log(
    `[wiki/extend] classified ${unclassifiedPaths.length - remainingUnclassified.length} paths; ${remainingUnclassified.length} remain unclassified`,
  );

  return { updatedTopics, remainingUnclassified };
}

/** Build a WikiSnapshotDoc from generation output. */
export function buildSnapshotDoc(
  branch: string,
  snapshotEntries: SnapshotEntry[],
  unclassifiedPaths: string[],
  headSha = '',
  treeSha = '',
): WikiSnapshotDoc {
  const now = new Date().toISOString();
  return {
    _id: `${branch}:snapshot`,
    kind: 'snapshot',
    branch,
    headSha,
    treeSha,
    fileListText: encodeFileList(snapshotEntries),
    unclassifiedPaths,
    lastEtag: null,
    leaseUntil: null,
    lastCheckedAt: now,
    lastRebuiltAt: now,
  };
}

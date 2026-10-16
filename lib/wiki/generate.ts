/**
 * generate.ts — Full initial topic generation via LLM.
 *
 * Calls the LLM once (non-streaming) with the file tree and asks for topics
 * with scopes. Repairs the output via validate.ts before returning.
 */

import { getLlmModel, llmClient } from '@/lib/llm';
import { formatTreeForPrompt, getBranchHead, getFileTreeResult } from '@/lib/github';
import { repairGeneratedTopics, findUnclassifiedPaths } from './validate';
import type { WikiTopicDoc, WikiSnapshotDoc, SnapshotEntry, SyncResult } from './types';
import { encodeFileList } from './snapshot';

const REPO_OWNER = 'SonicDMG';
const REPO_NAME = 'walfly';

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

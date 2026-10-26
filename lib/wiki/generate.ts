/**
 * generate.ts — Full initial topic generation + incremental extension via LLM.
 *
 * generateTopics(repo, branch)  — Full generation from scratch.
 * extendTopics(branch, unclassifiedPaths, currentTopics, allPaths)
 *                         — Incremental call: creates new topics or extends
 *                           existing scopes for unclassified paths, without
 *                           rewriting existing topic titles/descriptions.
 */

import type OpenAI from 'openai';
import { getLlmModel, llmClient, supportsJsonMode } from '@/lib/llm';
import {
  fetchFileContents,
  formatTreeForPrompt,
  getBranchHead,
  getFileTreeResult,
  isIgnoredPath,
} from '@/lib/github';
import { repairGeneratedTopics, findUnclassifiedPaths } from './validate';
import { promoteDirectoryPrefixes, pathMatchesScope } from './scope';
import { TOPIC_SECTIONS, splitRepo, topicId, snapshotId } from './types';
import { wikiPrompt, picturePrompt, TEMPLATE_VERSIONS } from './prompts';
import { computeFingerprint } from './fingerprint';
import { hasPictureCards } from './staleness';
import type { RepoKey, TopicSection, WikiTopicDoc, WikiSnapshotDoc, SnapshotEntry, SyncResult } from './types';
import { encodeFileList } from './snapshot';

/** Placeholder pages stored when generation had nothing to work with. */
export const NO_SOURCE_FILES_PAGE = `No source files found matching this topic's scope.`;
export const FETCH_FAILED_PAGE = `Could not fetch source files for this topic.`;

/** README excerpt given to the generator so topics follow what the system does, not the folder layout. */
const README_CHARS = 6_000;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Shared definition of a topic, used by both full generation and extension. */
const TOPIC_FIELDS = `Each topic is an object with:
  "section": one of ${TOPIC_SECTIONS.map((s) => `"${s}"`).join(' | ')}
      Start here   — 1–2 topics: architecture overview, running it locally.
      How it works — end-to-end flows and features. Most topics belong here.
      Codebase     — a tour of a package or app, only where its structure is worth explaining.
      Reference    — data model, configuration, tooling.
  "title": 2–5 words, distinct from every other title
  "description": one sentence on what the reader will understand (max 120 chars)
  "suggestedQuery": the question sent to the Q&A assistant, phrased to get an explanatory page,
      e.g. "How does a recording travel from the phone to a searchable document?" (max 110 chars)
  "scope": { "prefixes": [directories ending in "/"], "files": [file paths] } — the source that
      implements this topic. Used to notice when code changes; scopes may overlap.`;

/** Raw topic as the LLM returns it, before validation. */
interface RawTopic {
  title?: unknown;
  description?: unknown;
  suggestedQuery?: unknown;
  section?: unknown;
  scope?: { prefixes?: unknown; files?: unknown };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Map one raw LLM topic to a stored doc, or null if required fields are missing. */
function toTopicDoc(raw: RawTopic, repo: RepoKey, branch: string, order: number, now: string): WikiTopicDoc | null {
  if (typeof raw?.title !== 'string' || typeof raw.description !== 'string') return null;
  if (typeof raw.suggestedQuery !== 'string') return null;
  const title = raw.title.trim();
  const slug = slugify(title);
  const section = TOPIC_SECTIONS.includes(raw.section as TopicSection)
    ? (raw.section as TopicSection)
    : 'How it works';
  return {
    _id: topicId(repo, branch, slug),
    kind: 'topic',
    repo,
    branch,
    slug,
    order,
    title,
    description: raw.description.trim().slice(0, 150),
    suggestedQuery: raw.suggestedQuery.trim().slice(0, 120),
    section,
    scope: { prefixes: stringArray(raw.scope?.prefixes), files: stringArray(raw.scope?.files) },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Run a completion that must return a JSON object. Tries JSON mode first and
 * falls back to a plain request for proxies that reject `response_format`.
 * Returns null when the reply isn't parseable.
 */
async function completeJsonObject(system: string, user: string): Promise<Record<string, unknown> | null> {
  const client = llmClient();
  const request = {
    model: getLlmModel(),
    stream: false as const,
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
  };

  let response: OpenAI.Chat.Completions.ChatCompletion | null = null;
  if (supportsJsonMode()) {
    try {
      response = await client.chat.completions.create({ ...request, response_format: { type: 'json_object' } });
    } catch (err) {
      console.warn('[wiki] JSON mode request failed, retrying without it:', err instanceof Error ? err.message : err);
    }
  }
  response ??= await client.chat.completions.create(request);

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    console.warn('[wiki] JSON parse failed, raw:', raw.slice(0, 300));
    return null;
  }
}

/**
 * Generate topics for a branch from scratch.
 * Fetches the file tree and README, calls the LLM, repairs the output, and
 * returns a SyncResult plus the snapshot data needed to persist it.
 */
export async function generateTopics(repo: RepoKey, branch: string): Promise<{
  result: SyncResult;
  snapshotEntries: SnapshotEntry[];
  unclassifiedPaths: string[];
  treeSha: string;
}> {
  const { owner, name } = splitRepo(repo);
  const head = await getBranchHead(owner, name, branch);
  if (head.status !== 'ok') {
    throw new Error(
      head.status === 'rate-limited'
        ? 'GitHub rate limit reached while resolving branch head'
        : `Could not resolve head of branch "${branch}"`,
    );
  }
  const { entries, treeSha } = await getFileTreeResult(owner, name, head.sha);
  const treeText = formatTreeForPrompt(entries);
  const allPaths = entries.filter((e) => e.type === 'blob' && !isIgnoredPath(e.path)).map((e) => e.path);
  const readme = (await fetchFileContents(owner, name, ['README.md'], head.sha))['README.md'] ?? '';

  console.log(`[wiki] generating topics for branch "${branch}" — ${allPaths.length} files`);

  const parsed = await completeJsonObject(
    `You design the table of contents for a developer wiki about the ${repo} repository.
A newcomer reads these topics top to bottom to learn the codebase. Clicking a topic sends its
suggestedQuery to a Q&A assistant that reads the source and writes a page.

Produce 8–12 topics that explain the system — its features, flows and concepts. Do NOT make one topic
per directory. Good titles: "Recording Lifecycle", "Live Transcription Sidecar", "Search & Chat".
Bad titles: "Mobile Hooks", "API Core Libraries", "Mobile UI Components".

${TOPIC_FIELDS}

Rules:
- No two topics may cover the same subject, and no two questions may be near-duplicates.
- Order topics by section: Start here, How it works, Codebase, Reference.
- The LAST topic is title "Repo Config & Tooling", section "Reference", scope.prefixes [] and
  scope.files listing root config files, CI files and package.json files.
- Output ONLY a JSON object: {"topics": [ ... ]}. No markdown fences, no prose.`,
    `README.md:\n${readme.slice(0, README_CHARS)}\n\nFile tree for ${repo} (branch: ${branch}):\n\n${treeText}`,
  );

  const now = new Date().toISOString();
  const sectionRank = (t: WikiTopicDoc) => TOPIC_SECTIONS.indexOf(t.section ?? 'How it works');
  const mappedTopics = (Array.isArray(parsed?.topics) ? (parsed.topics as RawTopic[]) : [])
    .map((t, i) => toTopicDoc(t, repo, branch, i, now))
    .filter((t): t is WikiTopicDoc => t !== null)
    // Stable sort: keeps the model's order within each section.
    .sort((a, b) => sectionRank(a) - sectionRank(b));

  // Repair: drop empty/duplicate topics, reject over-broad prefixes, ensure catch-all.
  const repairedTopics = repairGeneratedTopics(mappedTopics, allPaths, repo, branch);
  const unclassifiedPaths = findUnclassifiedPaths(allPaths, repairedTopics);

  if (unclassifiedPaths.length > 0) {
    console.log(`[wiki] ${unclassifiedPaths.length} paths unclassified after generation`);
  }

  // Build snapshot entries with blob SHAs from the GitHub tree API.
  const snapshotEntries: SnapshotEntry[] = entries
    .filter((e) => e.type === 'blob')
    .map((e) => ({ sha: e.sha ?? '', path: e.path }));

  return {
    result: {
      topics: repairedTopics,
      headSha: head.sha,
      repo,
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
  repo: RepoKey,
  branch: string,
  unclassifiedPaths: string[],
  currentTopics: WikiTopicDoc[],
  allPaths: string[],
): Promise<{ updatedTopics: WikiTopicDoc[]; remainingUnclassified: string[] }> {
  if (unclassifiedPaths.length === 0) {
    return { updatedTopics: currentTopics, remainingUnclassified: [] };
  }

  const existingTitlesList = currentTopics
    .map((t, i) => `${i + 1}. slug="${t.slug}" title="${t.title}" — ${t.description}`)
    .join('\n');

  console.log(
    `[wiki/extend] incremental extension for ${unclassifiedPaths.length} unclassified paths on branch "${branch}"`,
  );

  const parsed = await completeJsonObject(
    `You maintain the table of contents of a developer wiki for the ${repo} repository.
You are given file paths that do not yet belong to any wiki topic.

Almost always, assign each path to the EXISTING topic it most relates to by extending that topic's scope.
Create a new topic ONLY when the paths form a whole new feature area that no existing topic could
reasonably explain — never one that overlaps or rephrases an existing title. At most one new topic.

${TOPIC_FIELDS}

Rules:
- Do NOT rename or re-describe existing topics.
- Keep scopes narrow — no prefix covering more than 30% of all files.
- Output ONLY a JSON object:
    {"extensions": [{"slug": "<existing slug>", "newPrefixes": [...], "newFiles": [...]}],
     "newTopics": [ <topic object> ]}
- No markdown fences, no prose.`,
    `Existing topics:\n${existingTitlesList}\n\nUnclassified paths to assign:\n${unclassifiedPaths.join('\n')}`,
  );

  const now = new Date().toISOString();
  const updatedTopics: WikiTopicDoc[] = currentTopics.map((t) => ({ ...t }));

  // Apply extensions to existing topics (never touch title/description).
  const extensions = Array.isArray(parsed?.extensions)
    ? (parsed.extensions as Array<{ slug?: unknown; newPrefixes?: unknown; newFiles?: unknown }>)
    : [];
  for (const ext of extensions) {
    const idx = updatedTopics.findIndex((t) => t.slug === ext?.slug);
    if (idx < 0) continue;
    const topic = updatedTopics[idx];
    const addedPrefixes = stringArray(ext.newPrefixes).filter((p) => !topic.scope.prefixes.includes(p));
    const addedFiles = stringArray(ext.newFiles).filter((f) => !topic.scope.files.includes(f));
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

  // Add new topics, skipping anything that duplicates an existing slug, title or question.
  const CATCH_ALL_SLUG = 'repo-config-tooling';
  const taken = new Set(
    updatedTopics.flatMap((t) => [t.slug, slugify(t.suggestedQuery)]).concat(CATCH_ALL_SLUG),
  );
  const newTopics = Array.isArray(parsed?.newTopics) ? (parsed.newTopics as RawTopic[]) : [];
  for (const raw of newTopics.slice(0, 1)) {
    const topic = toTopicDoc(raw, repo, branch, updatedTopics.length, now);
    if (!topic || taken.has(topic.slug) || taken.has(slugify(topic.suggestedQuery))) continue;
    updatedTopics.push(topic);
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
  repo: RepoKey,
  branch: string,
  snapshotEntries: SnapshotEntry[],
  unclassifiedPaths: string[],
  headSha = '',
  treeSha = '',
): WikiSnapshotDoc {
  const now = new Date().toISOString();
  return {
    _id: snapshotId(repo, branch),
    kind: 'snapshot',
    repo,
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

type PageMode = 'wiki' | 'picture';

const PAGE_PROMPTS: Record<PageMode, (repo: string, githubBase: string, commitSha: string, filesBlock: string) => string> = {
  wiki: wikiPrompt,
  picture: picturePrompt,
};

/** Result of generatePagesForTopic: the pages plus the scope fingerprint they were built from. */
export interface GeneratedPages {
  wiki?: string;
  picture?: string;
  /** Scope fingerprint at generation time; undefined when no snapshot entries were supplied or no files were generated from. */
  fingerprint?: string;
}

/**
 * Topic fields to store for freshly generated pages. Only the modes present in
 * `pages` are written, so regenerating one mode never clobbers the other's fields.
 */
export function pageFieldsToStore(
  pages: GeneratedPages,
  commitSha: string,
  updatedAt: string = new Date().toISOString(),
): Partial<WikiTopicDoc> {
  const fields: Partial<WikiTopicDoc> = { pageCommitSha: commitSha, updatedAt };
  if (pages.wiki !== undefined) {
    fields.generatedPage = pages.wiki;
    fields.pageFingerprint = pages.fingerprint;
    fields.pageTemplateVersion = TEMPLATE_VERSIONS.wiki;
  }
  if (pages.picture !== undefined) {
    fields.generatedPagePicture = pages.picture;
    fields.pagePictureFingerprint = pages.fingerprint;
    fields.pagePictureTemplateVersion = TEMPLATE_VERSIONS.picture;
  }
  return fields;
}

/**
 * Generates the pre-built page content for a topic, in the given modes
 * (both by default), from the files in the topic's scope at `commitSha`.
 *
 * @param snapshotEntries - Optional full snapshot entries (path + blobSha),
 *   used to compute the returned scope fingerprint.
 */
export async function generatePagesForTopic(
  topic: WikiTopicDoc,
  commitSha: string,
  allPaths: string[],
  modes: PageMode[] = ['wiki', 'picture'],
  snapshotEntries?: SnapshotEntry[],
): Promise<GeneratedPages> {
  const { owner, name } = splitRepo(topic.repo);
  const allModes = (text: string) => Object.fromEntries(modes.map((m) => [m, text]));

  // 1. Find matching files in topic scope.
  const matchedPaths = allPaths.filter(
    (p) => !isIgnoredPath(p) && pathMatchesScope(p, topic.scope)
  );
  if (matchedPaths.length === 0) return allModes(NO_SOURCE_FILES_PAGE);

  // 2. Fetch matched file contents.
  const contents = await fetchFileContents(owner, name, matchedPaths, commitSha);
  const fetchedPaths = Object.keys(contents);
  if (fetchedPaths.length === 0) return allModes(FETCH_FAILED_PAGE);

  // 3. Format files block.
  const MAX_FILE_CHARS = 8000;
  const filesBlock = fetchedPaths
    .map((path) => {
      const raw = contents[path];
      const text = raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) : raw;
      const numbered = text
        .split('\n')
        .map((line, i) => `${i + 1}| ${line}`)
        .join('\n');
      const truncated = text.length < raw.length ? '\n... [truncated]' : '';
      return `<file path="${path}">\n${numbered}${truncated}\n</file>`;
    })
    .join('\n\n');

  // 4. Generate each mode's page in parallel.
  const client = llmClient();
  const model = getLlmModel();
  const githubBase = `https://github.com/${topic.repo}/blob/${commitSha}`;

  const generate = async (mode: PageMode) => {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: PAGE_PROMPTS[mode](topic.repo, githubBase, commitSha, filesBlock) },
        { role: 'user', content: topic.suggestedQuery },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? '';
  };

  // Compute fingerprint once if snapshot entries are available.
  const fingerprint = snapshotEntries ? computeFingerprint(topic.scope, snapshotEntries) : undefined;

  console.log(`[wiki/generate] generating ${modes.join(' + ')} page(s) for topic "${topic.title}"...`);
  const pages = await Promise.all(
    modes.map(async (mode) => {
      // A stored page is read many times, so retry picture pages whose cards don't parse.
      let page = await generate(mode);
      for (let retry = 0; mode === 'picture' && retry < PICTURE_RETRIES && !hasPictureCards(page); retry++) {
        console.warn(`[wiki/generate] picture page for "${topic.title}" has no valid cards; retrying (attempt ${retry + 1}). Output: ${page.slice(0, 300)}`);
        page = await generate(mode);
      }
      if (mode === 'picture' && !hasPictureCards(page)) {
        console.warn(`[wiki/generate] all attempts exhausted for "${topic.title}" picture page. Final output: ${page.slice(0, 300)}`);
      }
      return [mode, page] as const;
    }),
  );
  return { ...(Object.fromEntries(pages) as Partial<Record<PageMode, string>>), fingerprint };
}

const PICTURE_RETRIES = 2;

/**
 * Rebuilds the generated pages for a list of topics.
 */
export async function rebuildTopicPages(
  topics: WikiTopicDoc[],
  commitSha: string,
  allPaths: string[],
  entries?: SnapshotEntry[],
): Promise<WikiTopicDoc[]> {
  console.log(`[wiki] Rebuilding pages for ${topics.length} topics...`);
  const updatedTopics: WikiTopicDoc[] = [];

  // Generate pages in parallel to keep it fast!
  await Promise.all(
    topics.map(async (topic) => {
      try {
        console.log(`[wiki] Rebuilding page for topic "${topic.title}"...`);
        const pages = await generatePagesForTopic(topic, commitSha, allPaths, ['wiki', 'picture'], entries);
        updatedTopics.push({ ...topic, ...pageFieldsToStore(pages, commitSha) });
      } catch (err) {
        console.error(`[wiki] Failed to generate pages for topic "${topic.title}":`, err);
        updatedTopics.push(topic);
      }
    })
  );

  return updatedTopics;
}

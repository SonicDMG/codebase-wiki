/**
 * GET /api/wiki/toc
 *
 * Generates a table of contents for the Walfly codebase by:
 *   1. Fetching the repo file tree (60 s in-memory cache shared with /api/wiki/chat)
 *   2. Calling the LLM once (non-streaming) to produce a JSON array of topic objects
 *
 * The result is cached server-side for 5 minutes so repeated page loads are fast.
 */

import { NextResponse } from 'next/server';
import { getLlmModel, llmClient } from '@/lib/llm';
import { formatTreeForPrompt, getFileTree } from '@/lib/github';

export const runtime = 'nodejs';
export const maxDuration = 60;

const REPO_OWNER = 'SonicDMG';
const REPO_NAME = 'walfly';

export interface TocTopic {
  title: string;
  description: string;
  suggestedQuery: string;
}

// Server-side cache so the LLM isn't called on every page load.
let tocCache: { topics: TocTopic[]; expiresAt: number } | null = null;
const TOC_TTL_MS = 5 * 60_000; // 5 minutes

export async function GET() {
  // Serve from cache if still fresh.
  if (tocCache && Date.now() < tocCache.expiresAt) {
    return NextResponse.json({ topics: tocCache.topics });
  }

  let client: ReturnType<typeof llmClient>;
  let model: string;
  try {
    client = llmClient();
    model = getLlmModel();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'LLM is not configured' },
      { status: 500 },
    );
  }

  let treeText: string;
  try {
    const entries = await getFileTree(REPO_OWNER, REPO_NAME);
    treeText = formatTreeForPrompt(entries);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch file tree' },
      { status: 500 },
    );
  }

  const response = await client.chat.completions.create({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `You are a technical documentation assistant for the Walfly monorepo.
Given the file tree below, produce a table of contents for a developer wiki.
Output ONLY a JSON array of exactly 10–14 topic objects with these fields:
  - "title": short section title (3–6 words, e.g. "Backend API Overview")
  - "description": one sentence describing what a developer will learn from this section (max 120 chars)
  - "suggestedQuery": a natural-language question a developer would ask to explore this topic (max 100 chars)

Order topics from high-level (architecture, getting started) to low-level (data layer, infra).
No markdown fences, no prose — only the raw JSON array.`,
      },
      {
        role: 'user',
        content: `File tree for ${REPO_OWNER}/${REPO_NAME}:\n\n${treeText}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '[]';
  let topics: TocTopic[] = [];
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      topics = parsed.filter(
        (t): t is TocTopic =>
          typeof t?.title === 'string' &&
          typeof t?.description === 'string' &&
          typeof t?.suggestedQuery === 'string',
      );
    }
  } catch {
    console.warn('[wiki/toc] JSON parse failed, raw:', raw.slice(0, 300));
  }

  tocCache = { topics, expiresAt: Date.now() + TOC_TTL_MS };
  return NextResponse.json({ topics });
}

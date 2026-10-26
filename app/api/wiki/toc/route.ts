/**
 * GET /api/wiki/toc
 *
 * Returns wiki topics for a given branch. On first call:
 *   1. Checks Astra for stored topics — returns immediately if found.
 *   2. If none exist, generates topics via LLM, stores them in Astra, then returns.
 *
 * Query params:
 *   ?repo=<owner/name> — defaults to WIKI_DEFAULT_REPO
 *   ?branch=<branch>   — defaults to the repo's default branch
 *
 * Response shape:
 *   { topics: TocTopic[], repo: string, branch: string, headSha: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureTopics, toPublicTopics } from '@/lib/wiki/sync';
import { resolveBranch, resolveRepo } from '@/lib/wiki/repo';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Minimal shape the wiki page consumes (backwards-compatible). */
export interface TocTopic {
  title: string;
  description: string;
  suggestedQuery: string;
}

export async function GET(req: NextRequest) {
  const resolved = resolveRepo(req.nextUrl.searchParams.get('repo'));
  if (!resolved.ok) return resolved.response;
  const { repo } = resolved;
  const branch = await resolveBranch(repo, req.nextUrl.searchParams.get('branch'));

  try {
    const { topics, snapshot } = await ensureTopics(repo, branch);
    return NextResponse.json({ topics: toPublicTopics(topics), repo, branch, headSha: snapshot.headSha });
  } catch (err) {
    console.error('[wiki/toc] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate wiki topics' },
      { status: 500 },
    );
  }
}

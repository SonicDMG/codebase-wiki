/**
 * GET /api/wiki/toc
 *
 * Returns wiki topics for a given branch. On first call:
 *   1. Checks Astra for stored topics — returns immediately if found.
 *   2. If none exist, generates topics via LLM, stores them in Astra, then returns.
 *
 * Query params:
 *   ?branch=<branch>  — defaults to "main"
 *
 * Response shape:
 *   { topics: TocTopic[], branch: string, headSha: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { ensureTopics, toPublicTopics } from '@/lib/wiki/sync';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_BRANCH = 'main';

/** Minimal shape the wiki page consumes (backwards-compatible). */
export interface TocTopic {
  title: string;
  description: string;
  suggestedQuery: string;
}

export async function GET(req: NextRequest) {
  const branch = req.nextUrl.searchParams.get('branch')?.trim() || DEFAULT_BRANCH;

  try {
    const { topics, snapshot } = await ensureTopics(branch);
    return NextResponse.json({ topics: toPublicTopics(topics), branch, headSha: snapshot.headSha });
  } catch (err) {
    console.error('[wiki/toc] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate wiki topics' },
      { status: 500 },
    );
  }
}

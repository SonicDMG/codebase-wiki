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
 * Response shape (unchanged from previous version, plus new fields):
 *   { topics: TocTopic[], branch: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStoredTopics, saveTopics, saveSnapshot } from '@/lib/wiki/store';
import { generateTopics, buildSnapshotDoc } from '@/lib/wiki/generate';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DEFAULT_BRANCH = 'main';

/** Minimal shape the wiki page consumes (backwards-compatible). */
export interface TocTopic {
  title: string;
  description: string;
  suggestedQuery: string;
}

export async function GET(req: NextRequest) {
  const branch = req.nextUrl.searchParams.get('branch')?.trim() || DEFAULT_BRANCH;

  // ── 1. Try stored topics ──────────────────────────────────────────────────
  try {
    const stored = await getStoredTopics(branch);
    if (stored.length > 0) {
      console.log(`[wiki/toc] serving ${stored.length} stored topics for branch "${branch}"`);
      const topics: TocTopic[] = stored.map((t) => ({
        title: t.title,
        description: t.description,
        suggestedQuery: t.suggestedQuery,
      }));
      return NextResponse.json({ topics, branch });
    }
  } catch (err) {
    console.warn('[wiki/toc] Astra read failed, will try generation:', err);
  }

  // ── 2. Generate (first load for this branch) ──────────────────────────────
  try {
    const { result, snapshotEntries, unclassifiedPaths, treeSha } = await generateTopics(branch);

    // Persist topics.
    await saveTopics(result.topics);

    // Persist snapshot.
    const snapshot = buildSnapshotDoc(branch, snapshotEntries, unclassifiedPaths, result.headSha, treeSha);
    await saveSnapshot(snapshot);

    console.log(
      `[wiki/toc] generated and stored ${result.topics.length} topics for branch "${branch}"`,
    );

    const topics: TocTopic[] = result.topics.map((t) => ({
      title: t.title,
      description: t.description,
      suggestedQuery: t.suggestedQuery,
    }));
    return NextResponse.json({ topics, branch });
  } catch (err) {
    console.error('[wiki/toc] generation failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate wiki topics' },
      { status: 500 },
    );
  }
}

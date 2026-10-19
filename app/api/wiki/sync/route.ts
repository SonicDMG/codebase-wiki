/**
 * POST /api/wiki/sync
 *
 * Body: { branch?: string }  (defaults to "main")
 * Response: { status: 'synced' | 'unmodified' | 'locked', branch, headSha, topics, changeSummary? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { syncBranch, toPublicTopics } from '@/lib/wiki/sync';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_BRANCH = 'main';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;

  try {
    const outcome = await syncBranch(branch);
    return NextResponse.json({
      status: outcome.status,
      branch: outcome.branch,
      headSha: outcome.headSha,
      topics: toPublicTopics(outcome.topics),
      ...(outcome.changeSummary ? { changeSummary: outcome.changeSummary } : {}),
      ...(outcome.rateLimited !== undefined ? { rateLimited: outcome.rateLimited } : {}),
      ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
      ...(outcome.warning !== undefined ? { warning: outcome.warning } : {}),
    });
  } catch (err) {
    console.error('[wiki/sync] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to sync wiki topics' },
      { status: 500 },
    );
  }
}

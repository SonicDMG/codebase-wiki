/**
 * POST /api/wiki/backfill
 *
 * Body: { branch?: string }  (defaults to "main")
 * Fills in missing page fingerprints from GitHub (at each page's build commit).
 * Never triggers LLM generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { backfillBranch } from '@/lib/wiki/backfill';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DEFAULT_BRANCH = 'main';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;

  try {
    return NextResponse.json(await backfillBranch(branch));
  } catch (err) {
    console.error('[wiki/backfill] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to backfill wiki fingerprints' },
      { status: 500 },
    );
  }
}

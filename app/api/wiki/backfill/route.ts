/**
 * POST /api/wiki/backfill
 *
 * Body: { repo?: string, branch?: string }  (defaults: WIKI_DEFAULT_REPO, the repo's default branch)
 * Fills in missing page fingerprints from GitHub (at each page's build commit).
 * Never triggers LLM generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { backfillBranch } from '@/lib/wiki/backfill';
import { resolveBranch, resolveRepo } from '@/lib/wiki/repo';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { repo?: unknown; branch?: unknown };
  const resolved = resolveRepo(body.repo);
  if (!resolved.ok) return resolved.response;
  const { repo } = resolved;
  const branch = await resolveBranch(repo, body.branch);

  try {
    return NextResponse.json(await backfillBranch(repo, branch));
  } catch (err) {
    console.error('[wiki/backfill] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to backfill wiki fingerprints' },
      { status: 500 },
    );
  }
}

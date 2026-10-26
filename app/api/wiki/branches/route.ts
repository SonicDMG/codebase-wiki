/**
 * GET /api/wiki/branches
 *
 * Returns the branches of a repo plus its default branch.
 * Query: ?repo=owner/name (defaults to WIKI_DEFAULT_REPO)
 * Response: { branches: string[], defaultBranch: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { listBranches } from '@/lib/github';
import { resolveRepo } from '@/lib/wiki/repo';
import { splitRepo } from '@/lib/wiki/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const resolved = resolveRepo(req.nextUrl.searchParams.get('repo'));
  if (!resolved.ok) return resolved.response;
  const { owner, name } = splitRepo(resolved.repo);
  try {
    const result = await listBranches(owner, name);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[wiki/branches] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list branches' },
      { status: 500 },
    );
  }
}

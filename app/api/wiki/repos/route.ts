/**
 * GET /api/wiki/repos
 *
 * Repos that have a stored wiki, plus the configured default.
 * Response: { repos: Array<{ repo: string, branches: string[] }>, defaultRepo: string | null }
 */

import { NextResponse } from 'next/server';
import { getStoredRepos } from '@/lib/wiki/store';
import { getDefaultRepo } from '@/lib/wiki/repo';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return NextResponse.json({ repos: await getStoredRepos(), defaultRepo: getDefaultRepo() });
  } catch (err) {
    console.error('[wiki/repos] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list repos' },
      { status: 500 },
    );
  }
}

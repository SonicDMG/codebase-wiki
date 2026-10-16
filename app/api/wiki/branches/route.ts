/**
 * GET /api/wiki/branches
 *
 * Returns the list of branches for the configured repo plus the default branch.
 * Response: { branches: string[], defaultBranch: string }
 */

import { NextResponse } from 'next/server';
import { listBranches } from '@/lib/github';
import { REPO_OWNER, REPO_NAME } from '@/lib/wiki/generate';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const result = await listBranches(REPO_OWNER, REPO_NAME);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[wiki/branches] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list branches' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/wiki/rebuild
 *
 * Body: { branch?: string }  (defaults to "main")
 * Response: { status: 'started', jobId: string }
 *
 * Starts a detached rebuild job via the job runner and returns immediately.
 * 409 when a job is already running on the branch.
 * The actual rebuild runs in the background; poll /api/wiki/status or /api/wiki/jobs
 * to track progress.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJobRunner, JobAlreadyRunningError } from '@/lib/wiki/runner';

export const runtime = 'nodejs';

const DEFAULT_BRANCH = 'main';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  const branch =
    typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;

  try {
    const result = await getJobRunner().start(branch, { kind: 'rebuild' });
    return NextResponse.json({ status: result.status, jobId: (result as { jobId?: string }).jobId });
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) {
      return NextResponse.json({ error: err.message, jobId: err.jobId }, { status: 409 });
    }
    console.error('[wiki/rebuild] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start rebuild job' },
      { status: 500 },
    );
  }
}

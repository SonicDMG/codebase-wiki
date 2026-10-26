/**
 * POST /api/wiki/rebuild
 *
 * Body: { repo?: string, branch?: string }  (defaults: WIKI_DEFAULT_REPO, the repo's default branch)
 * Response: { status: 'started', jobId: string }
 *
 * Starts a detached rebuild job via the job runner and returns immediately.
 * 409 when a job is already running on the branch.
 * The actual rebuild runs in the background; poll /api/wiki/status or /api/wiki/jobs
 * to track progress.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJobRunner, JobAlreadyRunningError } from '@/lib/wiki/runner';
import { resolveBranch, resolveRepo } from '@/lib/wiki/repo';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { repo?: unknown; branch?: unknown };
  const resolved = resolveRepo(body.repo);
  if (!resolved.ok) return resolved.response;
  const { repo } = resolved;
  const branch = await resolveBranch(repo, body.branch);

  try {
    const result = await getJobRunner().start(repo, branch, { kind: 'rebuild' });
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

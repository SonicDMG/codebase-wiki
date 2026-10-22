/**
 * POST /api/wiki/jobs
 *   { branch?: string, action: 'start' | 'stop', kind?: 'refresh-stale' }
 *
 * 'start' returns immediately with { jobId } — the job runs detached on the
 * server. 409 when a job is already running on the branch.
 * 'stop' sets the cancel flag (checked between topics); 200 even if nothing runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJobRunner, JobAlreadyRunningError } from '@/lib/wiki/runner';
import type { WikiJobRequest } from '@/lib/wiki/types';

export const runtime = 'nodejs';

const DEFAULT_BRANCH = 'main';

export async function POST(req: NextRequest) {
  let body: { branch?: unknown; action?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;
  const runner = getJobRunner();

  try {
    if (body.action === 'start') {
      const kind = body.kind ?? 'refresh-stale';
      if (kind !== 'refresh-stale') {
        return NextResponse.json({ error: `Unknown job kind "${String(kind)}".` }, { status: 400 });
      }
      const request: WikiJobRequest = { kind };
      const result = await runner.start(branch, request);
      if (result.status === 'nothing-to-do') {
        return NextResponse.json({ status: 'nothing-to-do', message: 'No stale pages to refresh.' });
      }
      return NextResponse.json({ status: 'started', jobId: result.jobId });
    }

    if (body.action === 'stop') {
      const stopped = await runner.stop(branch);
      return NextResponse.json({
        stopped,
        message: stopped
          ? 'Stop requested. In-flight topics will finish and be saved.'
          : 'No job is running on this branch.',
      });
    }

    return NextResponse.json({ error: 'action must be "start" or "stop".' }, { status: 400 });
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) {
      return NextResponse.json({ error: err.message, jobId: err.jobId }, { status: 409 });
    }
    console.error('[wiki/job] request failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Job request failed' },
      { status: 500 },
    );
  }
}

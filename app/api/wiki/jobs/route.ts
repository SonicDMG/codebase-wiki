/**
 * POST /api/wiki/jobs
 *   {
 *     repo?: string,   // owner/name; defaults to WIKI_DEFAULT_REPO
 *     branch?: string,
 *     action: 'start' | 'stop' | 'resume',
 *     kind?: 'refresh-stale' | 'refresh-field-guide' | 'refresh-page' | 'rebuild' | 'integrity-check',
 *     onlyStale?: boolean,
 *     slug?: string,
 *     mode?: 'wiki' | 'picture'
 *   }
 *
 * 'start' returns immediately with { jobId } — the job runs detached on the
 * server. 409 when a job is already running on the branch.
 * 'stop' sets the cancel flag (checked between topics); 200 even if nothing runs.
 * 'resume' continues an interrupted (running-but-stale) job under the same
 * jobId and returns { status: 'resumed', jobId }. 409 when the job is live,
 * there is nothing to resume, or the job cannot be resumed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJobRunner, JobAlreadyRunningError } from '@/lib/wiki/runner';
import { resolveBranch, resolveRepo } from '@/lib/wiki/repo';
import type { WikiJobRequest } from '@/lib/wiki/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: {
    repo?: unknown;
    branch?: unknown;
    action?: unknown;
    kind?: unknown;
    onlyStale?: unknown;
    slug?: unknown;
    mode?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const resolved = resolveRepo(body.repo);
  if (!resolved.ok) return resolved.response;
  const { repo } = resolved;
  const branch = await resolveBranch(repo, body.branch);
  const runner = getJobRunner();

  try {
    if (body.action === 'start') {
      const kind = body.kind ?? 'refresh-stale';
      let request: WikiJobRequest;

      if (kind === 'refresh-stale') {
        request = { kind: 'refresh-stale' };
      } else if (kind === 'refresh-field-guide') {
        if (body.onlyStale !== undefined && typeof body.onlyStale !== 'boolean') {
          return NextResponse.json({ error: 'onlyStale must be a boolean.' }, { status: 400 });
        }
        request = {
          kind: 'refresh-field-guide',
          ...(typeof body.onlyStale === 'boolean' ? { onlyStale: body.onlyStale } : {}),
        };
      } else if (kind === 'refresh-page') {
        if (typeof body.slug !== 'string' || !body.slug.trim()) {
          return NextResponse.json({ error: 'slug is required for refresh-page.' }, { status: 400 });
        }
        if (body.mode !== 'wiki' && body.mode !== 'picture') {
          return NextResponse.json({ error: 'mode must be "wiki" or "picture".' }, { status: 400 });
        }
        request = {
          kind: 'refresh-page',
          slug: body.slug.trim(),
          mode: body.mode,
        };
      } else if (kind === 'rebuild') {
        request = { kind: 'rebuild' };
      } else if (kind === 'integrity-check') {
        request = { kind: 'integrity-check' };
      } else {
        return NextResponse.json({ error: `Unknown job kind "${String(kind)}".` }, { status: 400 });
      }

      const result = await runner.start(repo, branch, request);
      if (result.status === 'nothing-to-do') {
        return NextResponse.json({ status: 'nothing-to-do', message: 'No stale pages to refresh.' });
      }
      return NextResponse.json({ status: 'started', jobId: result.jobId });
    }

    if (body.action === 'stop') {
      const stopped = await runner.stop(repo, branch);
      return NextResponse.json({
        stopped,
        message: stopped
          ? 'Stop requested. In-flight topics will finish and be saved.'
          : 'No job is running on this branch.',
      });
    }

    if (body.action === 'resume') {
      const result = await runner.resume(repo, branch);
      return NextResponse.json({ status: 'resumed', jobId: result.jobId });
    }

    return NextResponse.json({ error: 'action must be "start", "stop" or "resume".' }, { status: 400 });
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) {
      return NextResponse.json({ error: err.message, jobId: err.jobId }, { status: 409 });
    }
    if (
      err instanceof Error &&
      (err.message === 'Nothing to resume' || err.message.includes('cannot be resumed'))
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Error && err.message.startsWith('Unknown topic')) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[wiki/job] request failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Job request failed' },
      { status: 500 },
    );
  }
}

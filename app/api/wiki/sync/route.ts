/**
 * POST /api/wiki/sync
 *
 * Body: { repo?: string, branch?: string }  (defaults: WIKI_DEFAULT_REPO, the repo's default branch)
 * Response: { status: 'synced' | 'unmodified' | 'locked', repo, branch, headSha, topics, changeSummary? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { syncBranch, toPublicTopics } from '@/lib/wiki/sync';
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
    const outcome = await syncBranch(repo, branch);
    return NextResponse.json({
      status: outcome.status,
      repo: outcome.repo,
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

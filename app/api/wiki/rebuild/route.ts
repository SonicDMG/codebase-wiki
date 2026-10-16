/**
 * POST /api/wiki/rebuild
 *
 * Body: { branch?: string }  (defaults to "main")
 * Response: { status: 'synced' | 'locked', branch, headSha, topics, changeSummary? }
 *
 * Forces a complete rebuild of wiki topics from scratch for the specified branch,
 * replacing all existing topic documents and snapshot state.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateTopics, buildSnapshotDoc } from '@/lib/wiki/generate';
import {
  acquireLease,
  releaseLease,
  deleteTopicsForBranch,
  saveTopics,
  saveSnapshot,
  getStoredTopics,
  getSnapshot,
} from '@/lib/wiki/store';
import { toPublicTopics } from '@/lib/wiki/sync';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DEFAULT_BRANCH = 'main';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  const branch =
    typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;

  if (!(await acquireLease(branch))) {
    const [storedTopics, snapshot] = await Promise.all([
      getStoredTopics(branch),
      getSnapshot(branch),
    ]);
    return NextResponse.json({
      status: 'locked',
      branch,
      headSha: snapshot?.headSha ?? '',
      topics: toPublicTopics(storedTopics),
      changeSummary: 'Rebuild locked by concurrent sync',
    });
  }

  try {
    const { result, snapshotEntries, unclassifiedPaths, treeSha } = await generateTopics(branch);

    // Replace all topic documents for this branch wholesale
    await deleteTopicsForBranch(branch);
    await saveTopics(result.topics);

    // Save fresh snapshot document
    const snapshot = buildSnapshotDoc(
      branch,
      snapshotEntries,
      unclassifiedPaths,
      result.headSha,
      treeSha,
    );
    await saveSnapshot({ ...snapshot, leaseUntil: null });

    return NextResponse.json({
      status: 'synced',
      branch: result.branch,
      headSha: result.headSha,
      topics: toPublicTopics(result.topics),
      changeSummary: `Rebuilt ${result.topics.length} topics from scratch`,
    });
  } catch (err) {
    console.error('[wiki/rebuild] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to rebuild wiki topics' },
      { status: 500 },
    );
  } finally {
    await releaseLease(branch).catch((err) =>
      console.warn('[wiki/rebuild] lease release failed:', err),
    );
  }
}

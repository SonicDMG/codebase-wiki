/**
 * GET /api/wiki/status?branch=main
 *
 * Read-only: reports, per topic and per mode, whether the stored page is
 * current, built from older files, built with an older template, or missing.
 * Never triggers generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStoredTopics, getSnapshot } from '@/lib/wiki/store';
import { decodeFileList } from '@/lib/wiki/snapshot';
import { classifyStaleness } from '@/lib/wiki/staleness';
import { TEMPLATE_VERSION } from '@/lib/wiki/prompts';
import { backfillBranch, hasUnfingerprintedPages } from '@/lib/wiki/backfill';
import { isJobLive } from '@/lib/wiki/runner';
import type { StateCounts, WikiStatusResponse } from '@/lib/wiki/status-types';

export const runtime = 'nodejs';

const DEFAULT_BRANCH = 'main';

/** Branches whose backfill this server process has already attempted (even if some pages stayed unverifiable). */
const backfillAttempted = new Set<string>();

const zeroCounts = (): StateCounts => ({
  current: 0,
  'files-changed': 0,
  'older-template': 0,
  'missing-or-failed': 0,
});

export async function GET(req: NextRequest) {
  const branch = req.nextUrl.searchParams.get('branch')?.trim() || DEFAULT_BRANCH;

  try {
    let [topics, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);

    // One-time fingerprint backfill for pre-fingerprint pages. GitHub only, no LLM;
    // failures never fail the status response.
    let backfill: WikiStatusResponse['backfill'];
    if (!backfillAttempted.has(branch) && hasUnfingerprintedPages(topics)) {
      backfillAttempted.add(branch);
      try {
        const res = await backfillBranch(branch);
        backfill = { filled: res.filled, unverifiable: res.unverifiable.length };
        topics = await getStoredTopics(branch);
      } catch (err) {
        console.error('[wiki/status] backfill failed:', err);
      }
    }
    const counts = { wiki: zeroCounts(), picture: zeroCounts() };

    if (!snapshot || topics.length === 0) {
      const emptyJob = snapshot?.job ?? null;
      const empty: WikiStatusResponse = {
        job: emptyJob,
        interrupted: emptyJob?.status === 'running' && !isJobLive(emptyJob),
        recentJobs: snapshot?.recentJobs ?? [],
        branch,
        headSha: '',
        templateVersion: TEMPLATE_VERSION,
        counts,
        topics: [],
      };
      return NextResponse.json(empty);
    }

    const entries = decodeFileList(snapshot.fileListText);
    const snapshotJob = snapshot.job ?? null;
    const result: WikiStatusResponse = {
      job: snapshotJob,
      interrupted: snapshotJob?.status === 'running' && !isJobLive(snapshotJob),
      recentJobs: snapshot.recentJobs ?? [],
      branch,
      headSha: snapshot.headSha,
      templateVersion: TEMPLATE_VERSION,
      counts,
      ...(backfill ? { backfill } : {}),
      topics: topics.map((t) => {
        const wiki = classifyStaleness(t, 'wiki', entries);
        const picture = classifyStaleness(t, 'picture', entries);
        counts.wiki[wiki.state]++;
        counts.picture[picture.state]++;
        return { slug: t.slug, title: t.title, wiki, picture };
      }),
    };
    return NextResponse.json(result);
  } catch (err) {
    console.error('[wiki/status] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read wiki status' },
      { status: 500 },
    );
  }
}

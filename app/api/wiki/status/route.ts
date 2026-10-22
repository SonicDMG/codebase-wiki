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
import type { StateCounts, WikiStatusResponse } from '@/lib/wiki/status-types';

export const runtime = 'nodejs';

const DEFAULT_BRANCH = 'main';

const zeroCounts = (): StateCounts => ({
  current: 0,
  'files-changed': 0,
  'older-template': 0,
  'missing-or-failed': 0,
});

export async function GET(req: NextRequest) {
  const branch = req.nextUrl.searchParams.get('branch')?.trim() || DEFAULT_BRANCH;

  try {
    const [topics, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
    const counts = { wiki: zeroCounts(), picture: zeroCounts() };

    if (!snapshot || topics.length === 0) {
      const empty: WikiStatusResponse = {
        branch,
        headSha: '',
        templateVersion: TEMPLATE_VERSION,
        counts,
        topics: [],
      };
      return NextResponse.json(empty);
    }

    const entries = decodeFileList(snapshot.fileListText);
    const result: WikiStatusResponse = {
      branch,
      headSha: snapshot.headSha,
      templateVersion: TEMPLATE_VERSION,
      counts,
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

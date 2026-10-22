'use client';

import { useEffect, useRef } from 'react';
import type { WikiStatusResponse } from '@/lib/wiki/status-types';

/**
 * Calls `onChanged` when the set of topic slug+updatedAt values changes after
 * the first one seen for a branch (jobs, single-page refreshes, rebuilds).
 * Not triggered by the first status load or a branch switch.
 */
export function useTopicVersionWatch(
  status: WikiStatusResponse | null,
  onChanged: () => void,
): void {
  const last = useRef<{ branch: string; sig: string } | null>(null);
  const cb = useRef(onChanged);
  cb.current = onChanged;

  useEffect(() => {
    if (!status) return;
    const topics = status.topics.filter((t) => t.updatedAt);
    if (topics.length === 0) return;
    const sig = topics.map((t) => `${t.slug}@${t.updatedAt}`).join('|');
    const prev = last.current;
    last.current = { branch: status.branch, sig };
    if (prev && prev.branch === status.branch && prev.sig !== sig) cb.current();
  }, [status]);
}

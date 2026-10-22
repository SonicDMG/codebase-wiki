'use client';

import { useState, useCallback } from 'react';
import type { WikiJobKind, WikiJobRequest } from '@/lib/wiki/types';

/** Human-readable label for a job kind. */
export function jobKindLabel(kind: WikiJobKind): string {
  switch (kind) {
    case 'refresh-stale':
      return 'Refresh stale pages';
    case 'refresh-field-guide':
      return 'Refresh Field Guide';
    case 'refresh-page':
      return 'Refresh one page';
    case 'rebuild':
      return 'Rebuild from scratch';
    default:
      return kind;
  }
}

export function useJobActions(
  branch: string,
  refresh: () => void
): {
  busy: boolean;
  message: string | null;
  start: (request?: WikiJobRequest) => Promise<void>;
  stop: () => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const post = useCallback(
    async (action: 'start' | 'stop', request: WikiJobRequest = { kind: 'refresh-stale' }) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch('/api/wiki/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch, action, ...request }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(data?.error ?? `Request failed (${res.status})`);
        } else if (data?.status === 'nothing-to-do') {
          setMessage('Nothing to refresh.');
        } else if (action === 'stop' && data?.message) {
          setMessage(data.message);
        }
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Request failed');
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [branch, refresh]
  );

  const start = useCallback(
    (request?: WikiJobRequest) => post('start', request),
    [post]
  );
  const stop = useCallback(() => post('stop'), [post]);

  return { busy, message, start, stop };
}

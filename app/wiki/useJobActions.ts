'use client';

import { useState, useCallback } from 'react';

export function useJobActions(
  branch: string,
  refresh: () => void
): {
  busy: boolean;
  message: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const post = useCallback(
    async (action: 'start' | 'stop') => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch('/api/wiki/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch, action, kind: 'refresh-stale' }),
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

  const start = useCallback(() => post('start'), [post]);
  const stop = useCallback(() => post('stop'), [post]);

  return { busy, message, start, stop };
}

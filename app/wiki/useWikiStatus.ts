'use client';

import { useEffect, useState } from 'react';
import type { WikiStatusResponse } from '@/lib/wiki/status-types';

const POLL_MS = 45_000;

/**
 * Fetches /api/wiki/status for a branch on mount / branch change, then every
 * 45 seconds while the document is visible. Aborts and clears timers on cleanup.
 */
export function useWikiStatus(branch: string | null): {
  status: WikiStatusResponse | null;
  error: string | null;
} {
  const [status, setStatus] = useState<WikiStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branch) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`/api/wiki/status?branch=${encodeURIComponent(branch)}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
        if (disposed) return;
        setStatus(data as WikiStatusResponse);
        setError(null);
      } catch (err) {
        if (disposed || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.warn('[wiki] status fetch failed:', err);
        setError(err instanceof Error ? err.message : 'status fetch failed');
      }
    };

    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void load();
      }, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    setStatus(null);
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      stop();
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [branch]);

  return { status, error };
}

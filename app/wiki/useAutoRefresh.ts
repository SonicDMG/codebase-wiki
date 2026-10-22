'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { WikiStatusResponse } from '@/lib/wiki/status-types';

const LS_KEY = 'walfly_wiki_auto_refresh';
const RECENT_FAIL_MS = 10 * 60 * 1000; // 10 minutes

export interface UseAutoRefreshResult {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  pendingPrompt: boolean;
  confirmPrompt: () => void;
  dismissPrompt: () => void;
  staleTopicCount: number;
}

function buildSignature(
  branch: string,
  status: WikiStatusResponse,
  staleTopics: Array<{ slug: string; wikiState: string; picState: string }>
): string {
  const parts = staleTopics
    .map((t) => `${t.slug}/${t.wikiState}/${t.picState}`)
    .sort()
    .join(',');
  return `${branch}:${status.headSha}:${parts}`;
}

export function useAutoRefresh({
  branch,
  status,
  start,
  busy,
}: {
  branch: string | null;
  status: WikiStatusResponse | null;
  start: (req?: { kind: 'refresh-stale' }) => Promise<void>;
  busy: boolean;
}): UseAutoRefreshResult {
  // ready: true once we've read localStorage (after mount, avoids SSR mismatch)
  const [ready, setReady] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [pendingPrompt, setPendingPrompt] = useState(false);
  // Tick incremented on focus/visibilitychange to re-run the main effect
  const [focusTick, setFocusTick] = useState(0);

  // Guard refs
  const lastActedSigRef = useRef<string | null>(null); // last sig auto-started OR prompted/dismissed
  const inFlightRef = useRef(false);

  // Read localStorage after mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored === 'off') setEnabledState(false);
      else setEnabledState(true); // 'on' or absent → default ON
    } catch {
      // ignore (SSR / private browsing)
    }
    setReady(true);
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      localStorage.setItem(LS_KEY, v ? 'on' : 'off');
    } catch {
      // ignore
    }
    if (!v) setPendingPrompt(false);
  }, []);

  // Re-evaluate on focus / visibility changes
  useEffect(() => {
    const handler = () => setFocusTick((t) => t + 1);
    window.addEventListener('focus', handler);
    document.addEventListener('visibilitychange', handler);
    return () => {
      window.removeEventListener('focus', handler);
      document.removeEventListener('visibilitychange', handler);
    };
  }, []);

  // Compute stale topics (memoised inline – avoids ref dance)
  const staleTopics = status?.topics.filter(
    (t) => t.wiki.state !== 'current' || t.picture.state !== 'current'
  ) ?? [];
  const staleTopicCount = staleTopics.length;

  // Main auto-start effect
  useEffect(() => {
    if (!ready || !enabled || !branch || !status) return;
    if (staleTopicCount < 1) {
      setPendingPrompt(false);
      return;
    }

    // Do nothing if a job is live (running and not interrupted)
    const jobRunning = status.job?.status === 'running' && !status.interrupted;
    if (jobRunning) return;
    if (status.interrupted) return;
    if (busy) return;

    // Recent failure guard: if job finished failed/cancelled within last 10 min, back off
    if (status.job) {
      const j = status.job;
      if (j.status === 'failed' || j.status === 'cancelled') {
        const finishedAt = j.finishedAt ? new Date(j.finishedAt).getTime() : 0;
        if (Date.now() - finishedAt < RECENT_FAIL_MS) return;
      }
    }

    // Focus + visibility gate
    if (!document.hasFocus() || document.visibilityState !== 'visible') return;

    // Compute signature
    const sig = buildSignature(
      branch,
      status,
      staleTopics.map((t) => ({ slug: t.slug, wikiState: t.wiki.state, picState: t.picture.state }))
    );

    // Loop guard: never act twice for the same signature
    if (lastActedSigRef.current === sig) return;

    // In-flight guard
    if (inFlightRef.current) return;

    if (staleTopicCount <= 4) {
      // Auto-start
      lastActedSigRef.current = sig;
      setPendingPrompt(false);
      inFlightRef.current = true;
      void start({ kind: 'refresh-stale' }).finally(() => {
        inFlightRef.current = false;
      });
    } else {
      // Show prompt — mark sig so we don't re-prompt for the same set
      lastActedSigRef.current = sig;
      setPendingPrompt(true);
    }
  // focusTick is intentionally included to re-evaluate after tab regains focus
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, enabled, branch, status, staleTopicCount, busy, focusTick]);

  const confirmPrompt = useCallback(() => {
    if (!inFlightRef.current) {
      setPendingPrompt(false);
      inFlightRef.current = true;
      void start({ kind: 'refresh-stale' }).finally(() => {
        inFlightRef.current = false;
      });
    }
  }, [start]);

  const dismissPrompt = useCallback(() => {
    setPendingPrompt(false);
    // lastActedSigRef already set when the prompt was raised → same sig won't re-prompt
  }, []);

  return { enabled, setEnabled, pendingPrompt, confirmPrompt, dismissPrompt, staleTopicCount };
}

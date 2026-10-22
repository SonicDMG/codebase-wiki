'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { WikiJob } from '@/lib/wiki/types';
import { jobKindLabel } from './useJobActions';

const MAX_SEGMENTS = 40;
const MAX_SEGMENTS_COMPACT = 20;
const MIN_ANNOUNCE_GAP_MS = 2000;

const JP_CSS = `
.jp-root { display: flex; align-items: center; gap: 8px; min-width: 0; }
.jp-root.jp-full { width: 100%; margin-bottom: 12px; }
.jp-count { font-size: 12px; color: var(--w-textMuted, #57606a); white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.jp-label { font-size: 12px; color: var(--w-textMuted, #57606a); font-style: italic; white-space: nowrap; }
.jp-track { flex: 1 1 auto; min-width: 0; height: 8px; background: var(--w-border, #e2e4e8); border-radius: 4px; overflow: hidden; }
.jp-compact .jp-track { flex: 0 0 72px; height: 4px; border-radius: 2px; }
.jp-fill { height: 100%; width: 0; background: var(--w-amber, #F5A623); border-radius: inherit; transition: width 0.4s ease; }
.jp-fill.jp-stripes {
  background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.3) 0, rgba(255,255,255,0.3) 6px, transparent 6px, transparent 12px);
  background-size: 17px 17px;
  animation: jp-shimmer 0.9s linear infinite;
}
.jp-indet { width: 100%; opacity: 0.55; }
.jp-segs { display: flex; flex: 1 1 auto; min-width: 0; gap: 2px; }
.jp-compact .jp-segs { flex: 0 0 auto; }
.jp-seg { flex: 1 1 0; min-width: 0; max-width: 12px; aspect-ratio: 1 / 1; border-radius: 0; background: var(--w-border, #26325a); }
.jp-compact .jp-seg { flex: 0 0 6px; width: 6px; height: 6px; max-width: none; aspect-ratio: auto; }
.jp-seg.jp-on { background: var(--w-amber, #ffb347); }
.jp-seg.jp-live { background: var(--w-cyan, #5ef2ff); animation: jp-blink 0.8s steps(2, jump-none) infinite; }
.jp-seg.jp-march { animation: jp-march 1.2s steps(1, end) infinite; }
.jp-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
@keyframes jp-shimmer { from { background-position: 0 0; } to { background-position: 17px 0; } }
@keyframes jp-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes jp-march { 0%, 100% { background: var(--w-cyan, #5ef2ff); } 25% { background: var(--w-border, #26325a); } }
@media (prefers-reduced-motion: reduce) {
  .jp-fill { transition: none; }
  .jp-fill.jp-stripes { animation: none; background-image: none; }
  .jp-seg.jp-live, .jp-seg.jp-march { animation: none; }
  .jp-seg.jp-live { opacity: 1; background: var(--w-cyan, #5ef2ff); }
  .jp-seg.jp-march { background: var(--w-border, #26325a); }
  .jp-seg.jp-march.jp-first { background: var(--w-cyan, #5ef2ff); }
}
`;

interface AnnounceState {
  id: string | null;
  sized: boolean;
  lastFinished: number;
  lastStep: number;
  seenRunning: boolean;
  finalDone: boolean;
}

export function JobProgress({
  job,
  mode,
  interrupted = false,
  compact = false,
  announce = false,
  hideVisual = false,
}: {
  job: WikiJob;
  mode: 'wiki' | 'picture';
  interrupted?: boolean;
  compact?: boolean;
  /** Mount the polite sr-only announcer. Only one per page should set this. */
  announce?: boolean;
  /** Keep the announcer mounted but render no visible bar (e.g. header bar after the job ends). */
  hideVisual?: boolean;
}) {
  const { total, finished } = job;
  const live = job.status === 'running' && !interrupted;
  const indeterminate = total === 0;
  const label = job.kind === 'integrity-check' ? 'Check' : 'Refresh';

  // ── Milestone announcements ──────────────────────────────────────────────
  const [message, setMessage] = useState('');
  const stateRef = useRef<AnnounceState>({
    id: null,
    sized: false,
    lastFinished: 0,
    lastStep: 0,
    seenRunning: false,
    finalDone: false,
  });
  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef('');

  const say = useCallback((text: string) => {
    const wait = MIN_ANNOUNCE_GAP_MS - (Date.now() - lastEmitRef.current);
    if (wait <= 0 && !timerRef.current) {
      lastEmitRef.current = Date.now();
      setMessage(text);
      return;
    }
    pendingRef.current = text;
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastEmitRef.current = Date.now();
        setMessage(pendingRef.current);
      }, Math.max(wait, 0));
    }
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!announce) return;
    const r = stateRef.current;
    const pctStep = total > 0 ? Math.floor((finished * 10) / total) : 0;

    if (r.id !== job.id) {
      r.id = job.id;
      r.lastFinished = finished;
      r.lastStep = pctStep;
      r.seenRunning = live;
      r.finalDone = !live;
      r.sized = total > 0;
      if (live) {
        if (total === 0) say(`${label} started, designing topics`);
        else if (finished > 0) say(`${label} in progress, ${finished} of ${total} topics`);
        else say(`${label} started, ${total} topics`);
      }
      return;
    }

    if (live) {
      r.seenRunning = true;
      r.finalDone = false;
      if (!r.sized && total > 0) {
        r.sized = true;
        r.lastFinished = finished;
        r.lastStep = pctStep;
        say(`${label} started, ${total} topics`);
        return;
      }
      if (total > 0) {
        const step = Math.max(1, Math.round(total / 10));
        if (finished - r.lastFinished >= step || pctStep > r.lastStep) {
          r.lastFinished = finished;
          r.lastStep = pctStep;
          say(`${label} ${finished} of ${total} topics`);
        }
      }
    } else if (!interrupted && r.seenRunning && !r.finalDone) {
      r.finalDone = true;
      if (job.status === 'cancelled') say('Job stopped');
      else if (job.status === 'failed') say('Job failed');
      else say(`Job complete, ${job.succeeded} of ${total} succeeded, ${job.failures.length} failed`);
    }
  }, [announce, job.id, job.status, job.succeeded, job.failures.length, finished, total, live, interrupted, label, say]);

  // ── Visual ───────────────────────────────────────────────────────────────
  const ariaLabel = `${jobKindLabel(job.kind)} progress`;
  const clamped = Math.min(finished, total);
  const pct = total > 0 ? Math.min(100, Math.max(0, (clamped / total) * 100)) : 0;

  let bar: React.ReactNode;
  if (mode === 'picture') {
    const segCount = indeterminate ? 12 : Math.min(total, compact ? MAX_SEGMENTS_COMPACT : MAX_SEGMENTS);
    const filledSegs = indeterminate ? 0 : Math.floor((clamped * segCount) / total);
    const liveSeg = live && !indeterminate && filledSegs < segCount ? filledSegs : -1;
    const segs = [];
    for (let i = 0; i < segCount; i++) {
      let cls = 'jp-seg';
      let style: CSSProperties | undefined;
      if (indeterminate) {
        if (live) {
          cls += ' jp-march';
          style = { animationDelay: `${(i % 4) * 0.3}s` };
        }
        if (i === 0) cls += ' jp-first';
      } else if (i < filledSegs) cls += ' jp-on';
      else if (i === liveSeg) cls += ' jp-live';
      segs.push(<span key={i} className={cls} style={style} />);
    }
    bar = (
      <div
        className="jp-segs"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : total}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={indeterminate ? 'Designing topics' : `${clamped} of ${total} topics`}
      >
        {segs}
      </div>
    );
  } else {
    bar = (
      <div
        className="jp-track"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : total}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={indeterminate ? 'Designing topics' : `${clamped} of ${total} topics`}
      >
        <div
          className={`jp-fill${indeterminate ? ' jp-indet' : ''}${live ? ' jp-stripes' : ''}`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    );
  }

  const countText = indeterminate ? 'Designing topics…' : compact ? `${finished}/${total}` : `${finished} of ${total}`;

  return (
    <>
      <style>{JP_CSS}</style>
      {!hideVisual && (
        <div className={`jp-root${compact ? ' jp-compact' : ' jp-full'}`}>
          {bar}
          <span className={indeterminate ? 'jp-label' : 'jp-count'} aria-hidden="true">
            {countText}
          </span>
        </div>
      )}
      {announce && (
        <div className="jp-sr" role="status" aria-live="polite" aria-atomic="true">
          {message}
        </div>
      )}
    </>
  );
}

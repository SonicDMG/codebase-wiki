'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { WikiStatusResponse } from '@/lib/wiki/status-types';

type AnswerMode = 'wiki' | 'picture';

/**
 * Header button: "Refresh stale (N)" where N = pages that are not current in the
 * CURRENT answer mode. While a job runs it shows "Refreshing finished/total" and
 * a Stop button. Errors (409, failures) appear in a small aria-live region.
 */
export function RefreshStaleButton({
  branch,
  status,
  mode,
  refresh,
}: {
  branch: string;
  status: WikiStatusResponse | null;
  mode: AnswerMode;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const job = status?.job ?? null;
  const running = job?.status === 'running';
  const counts = status?.counts[mode];
  const stale = counts ? counts['files-changed'] + counts['older-template'] + counts['missing-or-failed'] : 0;

  const post = async (action: 'start' | 'stop') => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/wiki/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, action, kind: 'refresh-stale' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMessage(data?.error ?? `Request failed (${res.status})`);
      else if (data?.status === 'nothing-to-do') setMessage('Nothing to refresh.');
      else if (action === 'stop' && data?.message) setMessage(data.message);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // Report the latest finished job's failures inline.
  const failed = !running && job && job.failures.length > 0 ? job.failures : null;
  const note =
    message ??
    (failed
      ? `${failed.length} topic(s) failed; old pages kept: ${failed.map((f) => f.slug).join(', ')}`
      : null);

  return (
    <span style={s.wrap}>
      {running ? (
        <>
          <span style={s.label} role="status">
            Refreshing {job.finished}/{job.total}
          </span>
          <button
            type="button"
            style={s.button}
            onClick={() => void post('stop')}
            disabled={busy || !!job.cancelRequested}
            aria-label="Stop refreshing stale pages"
          >
            {job.cancelRequested ? 'Stopping…' : 'Stop'}
          </button>
        </>
      ) : (
        <button
          type="button"
          style={{ ...s.button, ...(stale === 0 || busy ? s.disabled : {}) }}
          onClick={() => void post('start')}
          disabled={stale === 0 || busy}
          aria-label={`Refresh ${stale} stale ${mode === 'wiki' ? 'wiki' : 'field guide'} pages`}
        >
          Refresh stale ({stale})
        </button>
      )}
      <span aria-live="polite" style={s.note}>
        {note}
      </span>
    </span>
  );
}

const s: Record<string, CSSProperties> = {
  wrap: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginRight: '10px' },
  label: { fontSize: '11px', whiteSpace: 'nowrap' },
  button: {
    fontSize: '11px',
    padding: '2px 10px',
    borderRadius: '999px',
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  note: { fontSize: '11px', color: '#b3261e', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};

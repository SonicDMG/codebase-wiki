'use client';

import { useState, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import type { WikiStatusResponse, StalenessState } from '@/lib/wiki/status-types';
import { StatusDot } from './StatusDot';
import { useJobActions } from './useJobActions';
import { useAutoRefresh } from './useAutoRefresh';
import { JobProgress } from './JobProgress';
import { ConfirmRebuildDialog } from './ConfirmRebuildDialog';

type AnswerMode = 'wiki' | 'picture';

const STATES: Array<{ key: StalenessState; label: string }> = [
  { key: 'current', label: 'Up to date' },
  { key: 'files-changed', label: 'Files changed' },
  { key: 'older-template', label: 'Older template' },
  { key: 'missing-or-failed', label: 'Missing or failed' },
];

export function WikiStatusPill({
  repo,
  branch,
  status,
  mode,
  refresh,
}: {
  repo: string;
  branch: string;
  status: WikiStatusResponse | null;
  mode: AnswerMode;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const rebuildOpenerRef = useRef<HTMLButtonElement>(null);
  const { busy, message, start, stop, resume } = useJobActions(repo, branch, refresh);
  const { enabled: autoEnabled, setEnabled: setAutoEnabled, pendingPrompt, confirmPrompt, dismissPrompt, staleTopicCount } = useAutoRefresh({ repo, branch, status, start, busy });

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on outside click or Escape. While the rebuild confirm dialog
  // is open, Escape belongs to the dialog alone.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !rebuildDialogOpen) {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, rebuildDialogOpen]);

  const job = status?.job ?? null;
  const interrupted = !!status?.interrupted;
  const running = job?.status === 'running' && !interrupted;

  const wikiCounts = status?.counts.wiki;
  const picCounts = status?.counts.picture;

  const currentCount = (wikiCounts?.current ?? 0) + (picCounts?.current ?? 0);
  const staleCount =
    (wikiCounts
      ? wikiCounts['files-changed'] + wikiCounts['older-template'] + wikiCounts['missing-or-failed']
      : 0) +
    (picCounts
      ? picCounts['files-changed'] + picCounts['older-template'] + picCounts['missing-or-failed']
      : 0);

  const picStaleCount = picCounts
    ? picCounts['files-changed'] + picCounts['older-template'] + picCounts['missing-or-failed']
    : 0;

  const totalPages = currentCount + staleCount;

  // Ring arc calculations
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  let ringRatio = 0;
  if (running && job && job.total > 0) {
    ringRatio = Math.min(1, Math.max(0, job.finished / job.total));
  } else if (!running && totalPages > 0) {
    ringRatio = Math.min(1, Math.max(0, currentCount / totalPages));
  } else if (!running) {
    ringRatio = 1;
  }
  const strokeDashoffset = circumference * (1 - ringRatio);

  // Health color
  const isWiki = mode === 'wiki';
  let healthColor = isWiki ? '#1a7f37' : '#7dff9a'; // green
  if (running || (interrupted && job)) {
    healthColor = isWiki ? '#b35900' : '#ffb347'; // amber
  } else if (
    (wikiCounts?.['missing-or-failed'] ?? 0) > 0 ||
    (picCounts?.['missing-or-failed'] ?? 0) > 0
  ) {
    healthColor = isWiki ? '#cf222e' : '#ff9e7a'; // red
  } else if (staleCount > 0) {
    healthColor = isWiki ? '#b35900' : '#ffb347'; // amber
  }

  if (!status) {
    return (
      <span style={s.pillWrapper}>
        <button
          type="button"
          style={{ ...s.pillButton, opacity: 0.6, cursor: 'default' }}
          disabled
          aria-label="Wiki status loading"
        >
          <span style={s.pillText}>Loading status…</span>
        </button>
      </span>
    );
  }

  // Pill display text and aria label
  let pillText: React.ReactNode = null;
  let pillAriaLabel = '';

  if (running && job) {
    if (job.total === 0) {
      pillText = 'Designing topics…';
      pillAriaLabel = 'Rebuild running: designing topics';
    } else {
      pillText = `${job.finished}/${job.total}`;
      pillAriaLabel = `${job.kind === 'integrity-check' ? 'Checking' : 'Refreshing'} ${job.finished} of ${job.total} topics`;
    }
  } else if (interrupted && job) {
    pillText = `Interrupted · ${job.finished}/${job.total}`;
    pillAriaLabel = `Wiki job interrupted at ${job.finished} of ${job.total} topics; open to resume`;
  } else if (staleCount === 0) {
    pillText = (
      <>
        <span style={{ marginRight: '3px' }}>✓</span> All current
      </>
    );
    pillAriaLabel = 'Wiki status: all pages current';
  } else {
    pillText = `${staleCount} stale`;
    pillAriaLabel = `Wiki status: ${staleCount} pages need refresh`;
  }

  // Failures note for dropdown
  const failed = !running && job && job.failures.length > 0 ? job.failures : null;
  const failureNote = failed
    ? job?.kind === 'integrity-check'
      ? `${failed.length} topic(s) with integrity problems: ${failed.map((f) => f.slug).join(', ')}`
      : `${failed.length} topic(s) failed; old pages kept: ${failed.map((f) => f.slug).join(', ')}`
    : null;

  return (
    <div ref={containerRef} style={s.pillWrapper}>
      <button
        ref={buttonRef}
        id="wiki-status-pill-btn"
        type="button"
        style={s.pillButton}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls="wiki-status-dropdown-dialog"
        aria-label={pillAriaLabel}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" style={s.ringSvg} aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2.2"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={healthColor}
            strokeWidth="2.2"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span style={s.pillText}>{pillText}</span>
        <span style={s.chevron} aria-hidden="true">
          ▾
        </span>
      </button>

      {job && (
        <JobProgress
          job={job}
          mode={mode}
          interrupted={interrupted}
          compact
          announce
          hideVisual={!running}
        />
      )}

      {open && (
        <div
          id="wiki-status-dropdown-dialog"
          role="dialog"
          aria-label="Wiki status"
          style={s.dropdown}
        >
          {/* Branch & Template info */}
          <div style={s.section}>
            <div style={s.branchHeader}>
              <span style={s.branchName}>{status.repo} · {status.branch}</span>
              <span style={s.sha}>@{status.headSha ? status.headSha.slice(0, 7) : '…'}</span>
            </div>
            <div style={s.templateVer}>Template v{status.templateVersion[mode]}</div>
          </div>

          <div style={s.divider} />

          {/* Counts Table */}
          <div style={s.section}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={{ ...s.th, textAlign: 'left' }}>State</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Wiki</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>Field Guide</th>
                </tr>
              </thead>
              <tbody>
                {STATES.map(({ key, label }) => {
                  const wCount = wikiCounts?.[key] ?? 0;
                  const pCount = picCounts?.[key] ?? 0;
                  return (
                    <tr key={key} style={s.tr}>
                      <td style={s.tdState}>
                        <span style={s.dotWrap}>
                          <StatusDot state={key} mode={mode} reason={label} />
                        </span>
                        <span>{label}</span>
                      </td>
                      <td style={{ ...s.tdCount, textAlign: 'right' }}>{wCount}</td>
                      <td style={{ ...s.tdCount, textAlign: 'right' }}>{pCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Job status line */}
          {job && (
            <>
              <div style={s.divider} />
              <div style={s.section}>
                <div style={s.jobSection}>
                  {running && <JobProgress job={job} mode={mode} />}
                  <div style={s.jobTitle}>
                    {running ? (
                      <span>
                        {job.kind === 'integrity-check' ? 'Checking' : 'Refreshing'} {job.finished}/{job.total}
                        {job.currentSlugs.length > 0 && ` (${job.currentSlugs.join(', ')})`}
                      </span>
                    ) : interrupted ? (
                      <span>
                        The last job was interrupted at {job.finished} of {job.total} topics
                        (server restarted or stopped).
                      </span>
                    ) : (
                      <span>
                        Last job: {job.status} ({job.finished}/{job.total} finished)
                      </span>
                    )}
                  </div>
                  {failureNote && <div style={s.failureNote}>{failureNote}</div>}
                </div>
              </div>
            </>
          )}

          {/* Live region for errors/messages */}
          <div aria-live="polite" style={s.liveRegion}>
            {message}
          </div>

          <div style={s.divider} />

          {/* Actions */}
          <div style={s.actionRow}>
            {running ? (
              <button
                type="button"
                style={s.stopBtn}
                onClick={() => void stop()}
                disabled={busy || !!job?.cancelRequested}
                aria-label="Stop refreshing stale pages"
              >
                {job?.cancelRequested ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <>
                {interrupted && (
                  <button
                    type="button"
                    style={{ ...s.resumeBtn, ...(busy ? s.btnDisabled : {}) }}
                    onClick={() => void resume()}
                    disabled={busy}
                    aria-label="Resume the interrupted job"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  style={{
                    ...s.refreshBtn,
                    ...(picStaleCount === 0 || busy ? s.btnDisabled : {}),
                  }}
                  onClick={() => void start({ kind: 'refresh-field-guide', onlyStale: true })}
                  disabled={picStaleCount === 0 || busy}
                  title={picStaleCount === 0 ? 'All Field Guide pages are up to date' : undefined}
                  aria-label={`Refresh ${picStaleCount} stale Field Guide pages only`}
                >
                  Refresh Field Guide only
                </button>
                <button
                  type="button"
                  style={{
                    ...s.refreshBtn,
                    ...(staleCount === 0 || busy ? s.btnDisabled : {}),
                  }}
                  onClick={() => void start()}
                  disabled={staleCount === 0 || busy}
                  title={staleCount === 0 ? 'All pages are up to date' : undefined}
                  aria-label={`Refresh ${staleCount} stale pages across Wiki and Field Guide`}
                >
                  Refresh stale ({staleCount})
                </button>
                <button
                  ref={rebuildOpenerRef}
                  type="button"
                  style={{ ...s.refreshBtn, ...(busy ? s.btnDisabled : {}) }}
                  disabled={busy}
                  aria-label="Rebuild the whole wiki from scratch"
                  onClick={() => setRebuildDialogOpen(true)}
                >
                  Rebuild from scratch
                </button>
              </>
            )}
          </div>

          <div style={s.divider} />

          {/* Auto-refresh toggle */}
          <div style={s.section}>
            <label style={s.autoRefreshLabel}>
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                style={s.autoRefreshCheckbox}
              />
              Auto-refresh out-of-date pages
            </label>
            <div style={s.autoRefreshHelper}>
              Runs in this tab only while it is focused. Waits for your click when more than 4 topics are out of date.
            </div>
          </div>

          <div style={s.divider} />
          <div style={s.statusPageRow}>
            <a
              href={`/wiki/status?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`}
              style={s.statusPageLink}
            >
              Status page →
            </a>
          </div>
        </div>
      )}

      {pendingPrompt && (
        <div
          role="region"
          aria-label="Auto-refresh prompt"
          style={s.autoRefreshPrompt}
        >
          <span style={s.autoRefreshPromptText}>
            {staleTopicCount} topics are out of date. Refresh them now?
          </span>
          <div style={s.autoRefreshPromptBtns}>
            <button
              type="button"
              style={s.autoRefreshConfirmBtn}
              onClick={confirmPrompt}
            >
              Refresh now
            </button>
            <button
              type="button"
              style={s.autoRefreshDismissBtn}
              onClick={dismissPrompt}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <ConfirmRebuildDialog
        open={rebuildDialogOpen}
        onConfirm={() => {
          setRebuildDialogOpen(false);
          setOpen(false);
          void start({ kind: 'rebuild' });
        }}
        onCancel={() => {
          setRebuildDialogOpen(false);
          rebuildOpenerRef.current?.focus();
        }}
      />
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  pillWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    marginRight: '10px',
  },
  pillButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--w-textMuted, #57606a)',
    background: 'var(--w-surface, #f7f8fa)',
    border: '1px solid var(--w-border, #e2e4e8)',
    borderRadius: '999px',
    padding: '2px 10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    lineHeight: '1.4',
  },
  ringSvg: {
    flexShrink: 0,
  },
  pillText: {
    whiteSpace: 'nowrap',
  },
  chevron: {
    fontSize: '10px',
    opacity: 0.7,
    marginLeft: '1px',
  },
  dropdown: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    background: 'var(--w-bg, #ffffff)',
    border: '1px solid var(--w-border, #e2e4e8)',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
    padding: '8px',
    zIndex: 100,
    minWidth: '280px',
    maxWidth: '340px',
    color: 'var(--w-text, #1a1a1f)',
    fontFamily: 'var(--w-fontBody, -apple-system, sans-serif)',
    fontSize: '12px',
  },
  section: {
    padding: '4px 6px',
  },
  branchHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 600,
  },
  branchName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sha: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: 'var(--w-textMuted, #57606a)',
    fontWeight: 400,
    fontSize: '11px',
  },
  templateVer: {
    fontSize: '11px',
    color: 'var(--w-textMuted, #57606a)',
    marginTop: '2px',
  },
  divider: {
    height: '1px',
    background: 'var(--w-border, #e2e4e8)',
    margin: '6px 0',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '11px',
  },
  th: {
    padding: '3px 4px',
    fontWeight: 600,
    color: 'var(--w-textMuted, #57606a)',
    borderBottom: '1px solid var(--w-border, #e2e4e8)',
  },
  tr: {
    borderBottom: '1px solid rgba(128, 128, 128, 0.08)',
  },
  tdState: {
    padding: '4px 4px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap',
  },
  dotWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '10px',
    height: '10px',
  },
  tdCount: {
    padding: '4px 4px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  jobSection: {
    fontSize: '11px',
  },
  jobTitle: {
    fontWeight: 500,
  },
  failureNote: {
    color: '#b3261e',
    fontSize: '11px',
    marginTop: '2px',
    overflowWrap: 'break-word',
  },
  liveRegion: {
    fontSize: '11px',
    color: '#b3261e',
    padding: '0 6px',
    minHeight: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  actionRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '4px 6px',
  },
  refreshBtn: {
    fontSize: '11px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: '1px solid var(--w-border, #e2e4e8)',
    background: 'var(--w-surface, #f7f8fa)',
    color: 'var(--w-text, #1a1a1f)',
    cursor: 'pointer',
    fontWeight: 500,
  },
  resumeBtn: {
    fontSize: '11px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: '1px solid var(--w-amber, #F5A623)',
    background: 'var(--w-amber, #F5A623)',
    color: 'var(--w-onAccent, #1a1a1f)',
    cursor: 'pointer',
    fontWeight: 500,
  },
  stopBtn: {
    fontSize: '11px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: '1px solid #b3261e',
    background: '#b3261e',
    color: '#ffffff',
    cursor: 'pointer',
    fontWeight: 500,
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  statusPageRow: {
    padding: '4px 6px',
    textAlign: 'center',
  },
  statusPageLink: {
    fontSize: '11px',
    color: 'var(--w-accentText, #92600a)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  autoRefreshLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontWeight: 500,
    color: 'var(--w-text, #1a1a1f)',
    cursor: 'pointer',
  },
  autoRefreshCheckbox: {
    cursor: 'pointer',
    accentColor: 'var(--w-amber, #F5A623)',
    width: '13px',
    height: '13px',
    flexShrink: 0,
  },
  autoRefreshHelper: {
    fontSize: '10px',
    color: 'var(--w-textMuted, #57606a)',
    marginTop: '3px',
    lineHeight: '1.4',
  },
  autoRefreshPrompt: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    background: 'var(--w-bg, #ffffff)',
    border: '1px solid var(--w-border, #e2e4e8)',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
    padding: '10px 12px',
    zIndex: 100,
    minWidth: '280px',
    maxWidth: '340px',
    fontFamily: 'var(--w-fontBody, -apple-system, sans-serif)',
    fontSize: '12px',
    color: 'var(--w-text, #1a1a1f)',
  },
  autoRefreshPromptText: {
    display: 'block',
    marginBottom: '8px',
    fontSize: '12px',
    lineHeight: '1.4',
  },
  autoRefreshPromptBtns: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
  autoRefreshConfirmBtn: {
    fontSize: '11px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: '1px solid var(--w-amber, #F5A623)',
    background: 'var(--w-amber, #F5A623)',
    color: 'var(--w-onAccent, #1a1a1f)',
    cursor: 'pointer',
    fontWeight: 500,
  },
  autoRefreshDismissBtn: {
    fontSize: '11px',
    padding: '4px 12px',
    borderRadius: '6px',
    border: '1px solid var(--w-border, #e2e4e8)',
    background: 'var(--w-surface, #f7f8fa)',
    color: 'var(--w-text, #1a1a1f)',
    cursor: 'pointer',
    fontWeight: 500,
  },
};

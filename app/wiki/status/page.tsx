'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { StalenessState } from '@/lib/wiki/status-types';
import { paletteCss } from '../palettes';
import { StatusDot } from '../StatusDot';
import { useWikiStatus } from '../useWikiStatus';
import { useJobActions, jobKindLabel } from '../useJobActions';
import { JobProgress } from '../JobProgress';
import { ConfirmRebuildDialog } from '../ConfirmRebuildDialog';

// ── State labels (matching WikiStatusPill) ─────────────────────────────────

const STATES: Array<{ key: StalenessState; label: string }> = [
  { key: 'current', label: 'Up to date' },
  { key: 'files-changed', label: 'Files changed' },
  { key: 'older-template', label: 'Older template' },
  { key: 'missing-or-failed', label: 'Missing or failed' },
];

// ── Inner component (uses useSearchParams) ─────────────────────────────────

function StatusPageInner() {
  const searchParams = useSearchParams();
  const paramBranch = searchParams.get('branch') ?? '';
  const paramTopic = searchParams.get('topic') ?? '';

  // Resolved branch: param or fetched default
  const [branch, setBranch] = useState<string | null>(paramBranch || null);
  const [branchLoading, setBranchLoading] = useState(!paramBranch);

  // Mode from localStorage
  const [mode, setMode] = useState<'wiki' | 'picture'>('wiki');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('walfly_wiki_mode');
      if (stored === 'wiki' || stored === 'picture') setMode(stored);
    } catch {
      // localStorage unavailable
    }
  }, []);

  // Fetch default branch if none supplied
  useEffect(() => {
    if (paramBranch) {
      setBranch(paramBranch);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    fetch('/api/wiki/branches')
      .then((r) => r.json())
      .then((data: { branches?: string[]; defaultBranch?: string }) => {
        if (!cancelled && data.defaultBranch) setBranch(data.defaultBranch);
      })
      .catch(() => {/* keep null */})
      .finally(() => { if (!cancelled) setBranchLoading(false); });
    return () => { cancelled = true; };
  }, [paramBranch]);

  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const rebuildBtnRef = useRef<HTMLButtonElement>(null);

  const { status, error, refresh } = useWikiStatus(branch);
  const { busy, message, start, stop, resume } = useJobActions(branch ?? '', refresh);

  // Scroll highlighted topic into view once status loads
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (paramTopic && status) {
      const el = document.getElementById(`topic-${paramTopic}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [paramTopic, status]);

  const job = status?.job ?? null;
  const interrupted = !!status?.interrupted;
  const running = job?.status === 'running' && !interrupted;

  const staleCount = status
    ? (status.counts.wiki['files-changed'] + status.counts.wiki['older-template'] + status.counts.wiki['missing-or-failed']) +
      (status.counts.picture['files-changed'] + status.counts.picture['older-template'] + status.counts.picture['missing-or-failed'])
    : 0;

  const picStaleCount = status
    ? status.counts.picture['files-changed'] +
      status.counts.picture['older-template'] +
      status.counts.picture['missing-or-failed']
    : 0;

  const workingSlugs = running && job ? job.currentSlugs : [];

  return (
    <div
      className="wiki-root"
      data-mode={mode}
      style={{
        background: 'var(--w-bg)',
        color: 'var(--w-text)',
        fontFamily: 'var(--w-fontBody)',
        minHeight: '100vh',
        padding: '0',
      }}
    >
      {/* Inject palette CSS vars */}
      <style dangerouslySetInnerHTML={{ __html: paletteCss() }} />

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px 20px' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: '24px' }}>
          <a
            href="/wiki"
            style={{ color: 'var(--w-accentText)', textDecoration: 'none', fontSize: '13px' }}
          >
            ← Back to wiki
          </a>
          <h1 style={{ fontFamily: 'var(--w-fontHeading)', fontSize: '22px', margin: '8px 0 4px' }}>
            Wiki Status
          </h1>
          {branchLoading && !branch && (
            <p style={{ color: 'var(--w-textMuted)', fontSize: '13px' }}>Loading branch…</p>
          )}
          {branch && (
            <div style={{ fontSize: '13px', color: 'var(--w-textMuted)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <span>
                Branch:{' '}
                <code style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--w-text)' }}>
                  {branch}
                </code>
              </span>
              {status?.headSha && (
                <span>
                  Commit:{' '}
                  <code style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--w-text)' }}>
                    {status.headSha.slice(0, 7)}
                  </code>
                </span>
              )}
              {status?.templateVersion !== undefined && (
                <span>Template v{status.templateVersion[mode]}</span>
              )}
            </div>
          )}
          {error && (
            <p role="alert" style={{ color: '#cf222e', fontSize: '13px', marginTop: '8px' }}>
              Error: {error}
            </p>
          )}
        </div>

        {status && (
          <>
            {/* ── Summary counts ── */}
            <section aria-labelledby="summary-heading" style={{ marginBottom: '28px' }}>
              <h2 id="summary-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                Summary
              </h2>
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}
                  aria-label="State counts per mode"
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--w-border)' }}>
                      <th scope="col" style={thStyle}>State</th>
                      <th scope="col" style={{ ...thStyle, textAlign: 'right' }}>Wiki</th>
                      <th scope="col" style={{ ...thStyle, textAlign: 'right' }}>Field Guide</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STATES.map(({ key, label }) => (
                      <tr key={key} style={{ borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                        <td style={tdStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <StatusDot state={key} mode={mode} reason={label} />
                            {label}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                          {status.counts.wiki[key]}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                          {status.counts.picture[key]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── Actions ── */}
            <section aria-labelledby="actions-heading" style={{ marginBottom: '28px' }}>
              <h2 id="actions-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                Actions
              </h2>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={busy || running || staleCount === 0}
                  style={{
                    ...btnBase,
                    ...(busy || running || staleCount === 0 ? btnDisabled : {}),
                  }}
                  aria-label={`Refresh ${staleCount} stale pages`}
                >
                  Refresh stale ({staleCount})
                </button>
                <button
                  type="button"
                  onClick={() => void start({ kind: 'refresh-field-guide', onlyStale: true })}
                  disabled={busy || running || picStaleCount === 0}
                  style={{
                    ...btnBase,
                    ...(busy || running || picStaleCount === 0 ? btnDisabled : {}),
                  }}
                  aria-label={`Refresh ${picStaleCount} stale Field Guide pages`}
                >
                  Refresh stale Field Guide pages ({picStaleCount})
                </button>
                <button
                  type="button"
                  onClick={() => void start({ kind: 'refresh-field-guide', onlyStale: false })}
                  disabled={busy || running}
                  style={{
                    ...btnBase,
                    ...(busy || running ? btnDisabled : {}),
                  }}
                  aria-label="Regenerate all Field Guide pages"
                >
                  Regenerate all Field Guide pages
                </button>
                <button
                  type="button"
                  onClick={() => void start({ kind: 'integrity-check' })}
                  disabled={busy || running}
                  style={{
                    ...btnBase,
                    ...(busy || running ? btnDisabled : {}),
                  }}
                  aria-label="Check the integrity of all stored pages"
                >
                  Check integrity
                </button>
                <button
                  ref={rebuildBtnRef}
                  type="button"
                  onClick={() => setRebuildDialogOpen(true)}
                  disabled={busy || running}
                  style={{
                    ...btnBase,
                    ...(busy || running ? btnDisabled : {}),
                  }}
                  aria-label="Rebuild the whole wiki from scratch"
                >
                  Rebuild from scratch
                </button>
                {interrupted && (
                  <button
                    type="button"
                    onClick={() => void resume()}
                    disabled={busy}
                    style={{
                      ...btnBase,
                      border: '1px solid #0f62fe',
                      background: '#0f62fe',
                      color: '#fff',
                      ...(busy ? btnDisabled : {}),
                    }}
                    aria-label="Resume the interrupted job"
                  >
                    Resume
                  </button>
                )}
                {running && (
                  <button
                    type="button"
                    onClick={() => void stop()}
                    disabled={busy || !!job?.cancelRequested}
                    style={{
                      ...btnBase,
                      border: '1px solid #cf222e',
                      background: '#cf222e',
                      color: '#fff',
                      ...(busy || !!job?.cancelRequested ? btnDisabled : {}),
                    }}
                    aria-label="Stop the running job"
                  >
                    {job?.cancelRequested ? 'Stopping…' : 'Stop'}
                  </button>
                )}
              </div>
              <div aria-live="polite" style={{ fontSize: '12px', color: '#cf222e', marginTop: '8px', minHeight: '18px' }}>
                {message}
              </div>
            </section>
            <ConfirmRebuildDialog
              open={rebuildDialogOpen}
              onConfirm={() => {
                setRebuildDialogOpen(false);
                void start({ kind: 'rebuild' });
              }}
              onCancel={() => {
                setRebuildDialogOpen(false);
                rebuildBtnRef.current?.focus();
              }}
            />

            {/* ── Live job ── */}
            {job && (
              <section aria-labelledby="job-heading" style={{ marginBottom: '28px' }}>
                <h2 id="job-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                  {interrupted ? 'Interrupted job' : running ? 'Running Job' : 'Latest Job'}
                </h2>
                {interrupted && (
                  <p style={{ fontSize: '13px', margin: '0 0 10px' }}>
                    The last job was interrupted at {job.finished} of {job.total} topics (server
                    restarted or stopped).
                  </p>
                )}
                <div style={{ fontSize: '13px', display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <span>
                    Status: <strong>{interrupted ? 'Interrupted' : job.status}</strong>
                  </span>
                  <span>
                    Progress: {job.finished}/{job.total}
                  </span>
                  <span>Succeeded: {job.succeeded}</span>
                  {job.failures.length > 0 && (
                    <span style={{ color: '#cf222e' }}>Failed: {job.failures.length}</span>
                  )}
                </div>

                {/* Progress bar (also mounted after the job ends so the final announcement fires) */}
                <JobProgress job={job} mode={mode} interrupted={interrupted} announce hideVisual={!running} />

                {/* Failures */}
                {job.failures.length > 0 && (
                  <div style={{ marginTop: '8px' }}>
                    <p style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: '#cf222e' }}>
                      {job.kind === 'integrity-check' ? 'Topics with problems:' : 'Failures (old pages kept):'}
                    </p>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '12px' }}>
                      {job.failures.map((f) => (
                        <li key={f.slug} style={{ padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                          <code style={{ fontFamily: 'ui-monospace, monospace' }}>{f.slug}</code>
                          {' '}[{f.modes.join(', ')}]{' '}
                          <span style={{ color: 'var(--w-textMuted)' }}>{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {/* ── Integrity check results ── */}
            {job?.integrity && (
              <section aria-labelledby="integrity-heading" style={{ marginBottom: '28px' }}>
                <h2 id="integrity-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                  Integrity check
                </h2>
                <p style={{ fontSize: '13px', margin: '0 0 10px', color: 'var(--w-textMuted)' }}>
                  Checked at {new Date(job.integrity.checkedAt).toLocaleString()}
                </p>
                {job.integrity.problems.length === 0 ? (
                  <p style={{ fontSize: '13px', margin: 0 }}>No problems found.</p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table
                      style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}
                      aria-label="Integrity problems"
                    >
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--w-border)' }}>
                          <th scope="col" style={thStyle}>Topic</th>
                          <th scope="col" style={thStyle}>Page</th>
                          <th scope="col" style={thStyle}>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {job.integrity.problems.map((p) => (
                          <tr key={`${p.slug}:${p.mode}:${p.reason}`} style={{ borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                            <td style={tdStyle}>
                              <a
                                href={`#topic-${p.slug}`}
                                style={{ color: 'var(--w-accentText)', fontFamily: 'ui-monospace, monospace' }}
                              >
                                {p.slug}
                              </a>
                            </td>
                            <td style={tdStyle}>{p.mode === 'wiki' ? 'Wiki' : 'Field Guide'}</td>
                            <td style={{ ...tdStyle, color: 'var(--w-textMuted)' }}>{p.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {/* ── Recent jobs ── */}
            {status.recentJobs.length > 0 && (
              <section aria-labelledby="recent-heading" style={{ marginBottom: '28px' }}>
                <h2 id="recent-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                  Recent Jobs
                </h2>
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}
                    aria-label="Recent jobs"
                  >
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--w-border)' }}>
                        <th scope="col" style={thStyle}>Kind</th>
                        <th scope="col" style={thStyle}>Status</th>
                        <th scope="col" style={{ ...thStyle, textAlign: 'right' }}>Finished/Total</th>
                        <th scope="col" style={{ ...thStyle, textAlign: 'right' }}>Failed</th>
                        <th scope="col" style={thStyle}>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.recentJobs.map((rj) => (
                        <tr key={rj.id} style={{ borderBottom: '1px solid rgba(128,128,128,0.1)' }}>
                          <td style={tdStyle}>{jobKindLabel(rj.kind)}</td>
                          <td style={tdStyle}>{rj.status}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                            {rj.finished}/{rj.total}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: rj.failed > 0 ? '#cf222e' : undefined }}>
                            {rj.failed}
                          </td>
                          <td style={{ ...tdStyle, color: 'var(--w-textMuted)' }}>
                            {new Date(rj.startedAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* ── Topics table ── */}
            <section aria-labelledby="topics-heading">
              <h2 id="topics-heading" style={{ fontSize: '15px', fontWeight: 600, marginBottom: '10px' }}>
                Topics ({status.topics.length})
              </h2>
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{ borderCollapse: 'collapse', width: '100%', fontSize: '13px' }}
                  aria-label="Per-topic status"
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--w-border)' }}>
                      <th scope="col" style={thStyle}>Topic</th>
                      <th scope="col" style={thStyle}>Wiki</th>
                      <th scope="col" style={thStyle}>Field Guide</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.topics.map((topic) => {
                      const isHighlighted = paramTopic === topic.slug;
                      const isWorking = workingSlugs.includes(topic.slug);
                      return (
                        <tr
                          key={topic.slug}
                          id={`topic-${topic.slug}`}
                          ref={isHighlighted ? highlightRef : undefined}
                          aria-current={isHighlighted ? 'true' : undefined}
                          aria-busy={isWorking ? true : undefined}
                          style={{
                            borderBottom: '1px solid rgba(128,128,128,0.1)',
                            background: isHighlighted || isWorking ? 'var(--w-amberLight)' : undefined,
                            boxShadow: isWorking ? 'inset 3px 0 0 var(--w-amber, #F5A623)' : undefined,
                          }}
                        >
                          <td style={tdStyle}>
                            {topic.title}
                            {isWorking && (
                              <span
                                style={{
                                  marginLeft: '8px',
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  color: 'var(--w-accentText)',
                                }}
                              >
                                Working…
                              </span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              <StatusDot state={topic.wiki.state} mode="wiki" reason={topic.wiki.reason} />
                              <span style={{ color: 'var(--w-textMuted)', fontSize: '12px' }}>
                                {topic.wiki.reason}
                              </span>
                              <button
                                type="button"
                                onClick={() => void start({ kind: 'refresh-page', slug: topic.slug, mode: 'wiki' })}
                                disabled={busy || running}
                                style={{ ...btnSmall, ...(busy || running ? btnDisabled : {}) }}
                                aria-label={`Refresh Wiki page for ${topic.title}`}
                              >
                                Refresh
                              </button>
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              <StatusDot state={topic.picture.state} mode="picture" reason={topic.picture.reason} />
                              <span style={{ color: 'var(--w-textMuted)', fontSize: '12px' }}>
                                {topic.picture.reason}
                              </span>
                              <button
                                type="button"
                                onClick={() => void start({ kind: 'refresh-page', slug: topic.slug, mode: 'picture' })}
                                disabled={busy || running}
                                style={{ ...btnSmall, ...(busy || running ? btnDisabled : {}) }}
                                aria-label={`Refresh Field Guide page for ${topic.title}`}
                              >
                                Refresh
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {!status && !error && branch && (
          <p style={{ color: 'var(--w-textMuted)', fontSize: '13px' }}>Loading status…</p>
        )}
        {!branch && !branchLoading && (
          <p role="alert" style={{ color: '#cf222e', fontSize: '13px' }}>
            No branch specified and default branch could not be determined.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontWeight: 600,
  textAlign: 'left',
  color: 'var(--w-textMuted)',
  fontSize: '12px',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'middle',
};

const btnBase: React.CSSProperties = {
  fontSize: '13px',
  padding: '6px 14px',
  borderRadius: '6px',
  border: '1px solid var(--w-border)',
  background: 'var(--w-surface)',
  color: 'var(--w-text)',
  cursor: 'pointer',
  fontWeight: 500,
};

const btnSmall: React.CSSProperties = {
  ...btnBase,
  fontSize: '11px',
  padding: '2px 8px',
};

const btnDisabled: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
};

// ── Default export: wraps inner in Suspense ────────────────────────────────

export default function WikiStatusPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: '40px', color: '#57606a', fontFamily: 'system-ui, sans-serif' }}>
          Loading…
        </div>
      }
    >
      <StatusPageInner />
    </Suspense>
  );
}

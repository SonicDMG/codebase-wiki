'use client';

/**
 * /wiki — Live Walfly Codebase Q&A
 *
 * Three-column layout:
 *   Left   — persistent TOC nav (auto-generated topics)
 *   Center — wiki-style article answers rendered with react-markdown + remark-gfm
 *   Right  — code reference sidebar; clicking a citation highlights the card
 *
 * The model writes plain Markdown plus ```diagram fences holding a small JSON
 * spec, which we compile to Mermaid ourselves so diagrams can't have syntax
 * errors. Raw HTML from the model is dropped by react-markdown (skipHtml).
 *
 * Every answer has two modes the reader can flip between: 'wiki' (the
 * technical page) and 'picture' (a picture book an 8-year-old could follow,
 * built from ```picture JSON cards). The other mode is generated on demand.
 */

import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';

const mdParser = unified().use(remarkParse).use(remarkGfm);

// ── Window extensions for CDN globals ─────────────────────────────────────
declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: HTMLElement) => void;
      configure: (opts: Record<string, unknown>) => void;
    };
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void;
      render: (id: string, definition: string) => Promise<{ svg: string }>;
    };
  }
}

const REPO_URL = 'https://github.com/SonicDMG/walfly';

// ── Walfly design tokens ───────────────────────────────────────────────────
const c = {
  amber:     '#F5A623',
  amberGlow: '#F5A62326',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

type AnswerMode = 'wiki' | 'picture';

const ANSWER_MODES: { mode: AnswerMode; label: string; title: string }[] = [
  { mode: 'wiki', label: '📖 Wiki', title: 'Technical wiki page' },
  { mode: 'picture', label: '🎨 Picture book', title: 'Explained with pictures, simple enough for an 8-year-old' },
];

interface Answer {
  content: string;
  pending?: boolean;
  /** Commit the answer was grounded in (sent by the server before the first token). */
  commit?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** The question (user messages). Assistant text lives in `answers`. */
  content: string;
  /** Assistant only: one answer per mode, each generated the first time it's shown. */
  answers?: Partial<Record<AnswerMode, Answer>>;
  /** Assistant only: the mode currently shown. */
  view?: AnswerMode;
}

function shownAnswer(m: Message | undefined): Answer | undefined {
  return m?.answers?.[m.view ?? 'wiki'];
}

/** What the server sees for a turn: the question, or the answer the reader is looking at. */
function toHistory(m: Message) {
  return { role: m.role, content: m.role === 'user' ? m.content : shownAnswer(m)?.content ?? '' };
}

/** A code block extracted from the LLM response, shown in the sidebar. */
interface RefBlock {
  index: number;
  label: string; // e.g. "llm.ts:24-31"
  url: string;   // github link
}

interface ParsedMessage {
  /** Raw markdown with code fences stripped out (they live in the sidebar). */
  prose: string;
  refs: RefBlock[];
}

interface TocTopic {
  title: string;
  description: string;
  suggestedQuery: string;
  /** Nav group heading; absent on topics generated before sections existed. */
  section?: string;
}

type SyncState = 'idle' | 'syncing' | 'up-to-date' | 'updated' | 'error' | 'rate-limited';

const SYNC_POLL_MS = 45_000;
const SYNC_POLL_CAP_MS = 300_000;

// ── Main component ─────────────────────────────────────────────────────────

export default function WikiPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: '',
      view: 'wiki',
      answers: {
        wiki: {
          content:
            '## Welcome\nAsk anything about the Walfly codebase. Answers are read **live from the GitHub source**, so they always match the current commit.\n\n- Pick a topic on the left for a guided overview\n- Or type your own question below\n- Choose **📖 Wiki** for the technical page or **🎨 Picture book** for a simple, picture-first explanation — and flip any answer between the two\n- Click a citation chip to see the exact code in the references panel',
        },
      },
    },
  ]);
  const [answerMode, setAnswerMode] = useState<AnswerMode>('wiki');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeRef, setActiveRef] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [tocTopics, setTocTopics] = useState<TocTopic[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [activeTopic, setActiveTopic] = useState<number | null>(null);
  const [wikiBranch, setWikiBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);

  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const tocReqIdRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const currentDelayRef = useRef(SYNC_POLL_MS);

  // ── Close status menu on outside click or Escape ─────────────────────────
  useEffect(() => {
    if (!statusMenuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStatusMenuOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [statusMenuOpen]);

  // ── Fetch branches ────────────────────────────────────────────────────────
  const fetchBranches = useCallback(async () => {
    if (branches.length > 0) return;
    try {
      const res = await fetch('/api/wiki/branches');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { branches?: string[]; defaultBranch?: string };
      if (Array.isArray(data.branches) && data.branches.length > 0) {
        setBranches(data.branches);
      }
    } catch (err) {
      console.warn('[wiki] branches load failed:', err);
    }
  }, [branches.length]);

  // ── Load TOC for a branch ─────────────────────────────────────────────────
  const loadToc = useCallback(async (branch?: string) => {
    const reqId = ++tocReqIdRef.current;
    setTocLoading(true);
    try {
      const url = branch ? `/api/wiki/toc?branch=${encodeURIComponent(branch)}` : '/api/wiki/toc';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { topics?: TocTopic[]; branch?: string; headSha?: string };
      if (reqId !== tocReqIdRef.current) return;
      if (Array.isArray(data.topics)) setTocTopics(data.topics);
      if (data.branch) {
        setWikiBranch(data.branch);
        setHeadSha(data.headSha ?? null);
        setSyncState('up-to-date');
      }
    } catch (err) {
      if (reqId === tocReqIdRef.current) {
        console.warn('[wiki] TOC load failed:', err);
        setSyncState('error');
      }
    } finally {
      if (reqId === tocReqIdRef.current) {
        setTocLoading(false);
      }
    }
  }, []);

  // ── Load branches and TOC on mount ─────────────────────────────────────────
  useEffect(() => {
    void fetchBranches();
    void loadToc();
  }, [fetchBranches, loadToc]);

  // ── Branch switcher ───────────────────────────────────────────────────────
  const handleBranchSelect = (newBranch: string) => {
    if (newBranch === wikiBranch) return;
    setWikiBranch(newBranch);
    setHeadSha(null);
    setSyncNote(null);
    setSyncWarning(null);
    setActiveTopic(null);
    void loadToc(newBranch);
  };

  // ── Poll for new commits (with exponential backoff & tab visibility check) ─
  useEffect(() => {
    if (!wikiBranch) return;
    let cancelled = false;
    let inFlight = false;
    currentDelayRef.current = SYNC_POLL_MS;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        scheduleNext(currentDelayRef.current);
        return;
      }

      inFlight = true;
      setSyncState('syncing');

      try {
        const res = await fetch('/api/wiki/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: wikiBranch }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          status: 'synced' | 'unmodified' | 'locked';
          headSha?: string;
          topics?: TocTopic[];
          changeSummary?: string;
          rateLimited?: boolean;
          retryAfterSeconds?: number;
          warning?: string;
        };

        if (cancelled) return;

        if (data.warning) {
          setSyncWarning(data.warning);
        } else {
          setSyncWarning(null);
        }

        if (data.rateLimited) {
          const retryMs =
            typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0
              ? data.retryAfterSeconds * 1000
              : 0;
          currentDelayRef.current = Math.min(
            SYNC_POLL_CAP_MS,
            Math.max(currentDelayRef.current * 2, retryMs),
          );
          setSyncState('rate-limited');
        } else {
          currentDelayRef.current = SYNC_POLL_MS;
          if (data.headSha) setHeadSha(data.headSha);
          if (data.status === 'synced') {
            if (Array.isArray(data.topics)) setTocTopics(data.topics);
            setSyncNote(data.changeSummary ?? null);
            setSyncState('updated');
          } else {
            setSyncState('up-to-date');
          }
        }
      } catch (err) {
        console.warn('[wiki] sync failed:', err);
        if (!cancelled) {
          currentDelayRef.current = Math.min(SYNC_POLL_CAP_MS, currentDelayRef.current * 2);
          setSyncState('error');
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          scheduleNext(currentDelayRef.current);
        }
      }
    };

    const onWake = () => {
      if (!cancelled && !inFlight && document.visibilityState === 'visible' && document.hasFocus()) {
        if (timerRef.current) clearTimeout(timerRef.current);
        void tick();
      }
    };

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);

    scheduleNext(currentDelayRef.current);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [wikiBranch]);

  // ── highlight.js + Mermaid from CDN ──────────────────────────────────────
  useEffect(() => {
    let link = document.getElementById('hljs-css') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = 'hljs-css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/tokyo-night-dark.min.css';

    if (!document.getElementById('hljs-script')) {
      const script = document.createElement('script');
      script.id = 'hljs-script';
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js';
      script.onload = () => window.hljs?.configure({ ignoreUnescapedHTML: true });
      document.head.appendChild(script);
    }

    if (!document.getElementById('mermaid-script')) {
      const script = document.createElement('script');
      script.id = 'mermaid-script';
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
      script.onload = () =>
        window.mermaid?.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'strict',
          // Don't inject the "Syntax error" bomb SVG into document.body.
          suppressErrorRendering: true,
          fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
          flowchart: { curve: 'basis', padding: 12 },
          themeVariables: {
            primaryColor: w.amberLight,
            primaryBorderColor: w.amberBorder,
            primaryTextColor: w.text,
            lineColor: w.textFaint,
            clusterBkg: w.surface,
            clusterBorder: w.border,
            edgeLabelBackground: w.bg,
            actorBkg: w.amberLight,
            actorBorder: w.amberBorder,
            noteBkgColor: w.surface,
            fontSize: '13px',
          },
        });
      document.head.appendChild(script);
    }
  }, []);

  // ── Drag-to-resize sidebar ────────────────────────────────────────────────
  // Width is written straight to the DOM while dragging (no per-move re-render
  // of the message list); React state is committed once on mouse-up.
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    let latest = sidebarWidth;
    setResizing(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current || !sidebarRef.current) return;
      const containerW = containerRef.current.offsetWidth;
      const delta = dragStartX.current - ev.clientX;
      latest = Math.min(Math.max(dragStartWidth.current + delta, 240), containerW - 320);
      sidebarRef.current.style.width = `${latest}px`;
    };
    const onMouseUp = () => {
      isDragging.current = false;
      setSidebarWidth(latest);
      setResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // When a new question is asked, bring it to the top of the reading pane.
  // Don't follow streaming tokens — the reader starts at the top of the answer.
  const lastQuestionId = [...messages].reverse().find((m) => m.role === 'user')?.id;
  useEffect(() => {
    if (!lastQuestionId) return;
    document.getElementById(`msg-${lastQuestionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [lastQuestionId]);

  const handleCitationClick = (idx: number) => {
    setActiveRef(idx);
    setSidebarCollapsed(false);
  };

  const latestAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

  // ── Stream one answer (in one mode) into an assistant message ─────────────
  const streamAnswer = useCallback(async (
    assistantId: string,
    mode: AnswerMode,
    history: { role: Message['role']; content: string }[],
  ) => {
    const patch = (fn: (a: Answer) => Answer) =>
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, answers: { ...m.answers, [mode]: fn(m.answers?.[mode] ?? { content: '' }) } }
            : m,
        ),
      );

    setLoading(true);
    setActiveRef(null);
    patch(() => ({ content: '', pending: true }));

    try {
      const res = await fetch('/api/wiki/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: wikiBranch ?? undefined,
          mode,
          messages: history,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        patch((a) => ({ ...a, content: `Error: ${(err as { error?: string }).error ?? 'Unknown error'}`, pending: false }));
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data) as { token?: string; error?: string; commit?: string };
            if (parsed.commit) {
              const commit = parsed.commit;
              patch((a) => ({ ...a, commit }));
            } else if (parsed.error) {
              patch((a) => ({ ...a, content: a.content + `\n\nError: ${parsed.error}`, pending: false }));
            } else if (parsed.token) {
              const token = parsed.token;
              patch((a) => ({ ...a, content: a.content + token }));
            }
          } catch { /* partial line */ }
        }
      }
    } catch (err) {
      patch((a) => ({ ...a, content: `Network error: ${err instanceof Error ? err.message : String(err)}`, pending: false }));
    } finally {
      patch((a) => ({ ...a, pending: false }));
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [wikiBranch]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading) return;

    if (!overrideQuestion) setInput('');

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: question };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', view: answerMode, answers: {} };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    await streamAnswer(assistantId, answerMode, [...messages, userMsg].map(toHistory));
  }, [input, loading, messages, answerMode, streamAnswer]);

  // ── Flip an answer between modes; the first flip generates the other version ─
  const showAnswerAs = useCallback((assistantId: string, mode: AnswerMode) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    const msg = messages[idx];
    if (!msg || msg.view === mode) return;
    const needsAnswer = !msg.answers?.[mode];
    if (needsAnswer && loading) return;

    setActiveRef(null);
    setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, view: mode } : m)));
    // History ends with the question this message answers.
    if (needsAnswer) void streamAnswer(assistantId, mode, messages.slice(0, idx).map(toHistory));
  }, [messages, loading, streamAnswer]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleTopicClick = (topic: TocTopic, idx: number) => {
    setActiveTopic(idx);
    void send(topic.suggestedQuery);
  };

  const handleRebuild = async () => {
    if (!wikiBranch || rebuilding) return;
    setRebuilding(true);
    try {
      const res = await fetch('/api/wiki/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: wikiBranch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        status: 'synced' | 'locked';
        headSha?: string;
        topics?: TocTopic[];
        changeSummary?: string;
      };
      if (data.headSha) setHeadSha(data.headSha);
      if (Array.isArray(data.topics)) setTocTopics(data.topics);
      setSyncNote(data.changeSummary ?? 'rebuilt all topics');
      setSyncState('updated');
      setStatusMenuOpen(false);
    } catch (err) {
      console.warn('[wiki] rebuild failed:', err);
      setSyncState('error');
      setSyncNote('rebuild failed');
    } finally {
      setRebuilding(false);
    }
  };

  const latestAnswer = shownAnswer(latestAssistantMsg);
  const parsedLatest = latestAnswer ? parseMessage(latestAnswer.content, latestAnswer.commit) : null;

  return (
    <div style={styles.root}>
      <GlobalMdStyles />
      {/* ── Header ── */}
      <header style={styles.header}>
        <span style={styles.title}>Walfly Wiki</span>
        <span style={styles.subtitle}> — live codebase Q&A</span>
        {wikiBranch && (
          <div ref={statusMenuRef} style={{ position: 'relative', display: 'inline-block' }}>
            <button
              type="button"
              aria-expanded={statusMenuOpen}
              aria-haspopup="true"
              onClick={() => {
                setStatusMenuOpen((prev) => {
                  const next = !prev;
                  if (next) void fetchBranches();
                  return next;
                });
              }}
              style={{
                ...styles.syncPill,
                ...(syncState === 'updated' ? styles.syncPillUpdated : {}),
                ...(syncState === 'error' ? styles.syncPillError : {}),
                ...(syncState === 'rate-limited' ? styles.syncPillRateLimited : {}),
                cursor: 'pointer',
              }}
              title={syncNote ?? undefined}
            >
              {wikiBranch} @ {headSha ? headSha.slice(0, 7) : '…'} ·{' '}
              {rebuilding
                ? 'rebuilding…'
                : syncState === 'syncing'
                  ? 'syncing…'
                  : syncState === 'updated'
                    ? `updated${syncNote ? ` (${syncNote})` : ''}`
                    : syncState === 'rate-limited'
                      ? 'rate-limited · retrying'
                      : syncState === 'error'
                        ? 'sync failed'
                        : 'up to date'}{' '}
              ▾
            </button>
            {statusMenuOpen && (
              <div style={styles.statusDropdown}>
                <div style={styles.dropdownSection}>
                  <label htmlFor="wiki-branch-select" style={styles.branchLabel}>
                    Branch
                  </label>
                  <select
                    id="wiki-branch-select"
                    value={wikiBranch}
                    onChange={(e) => handleBranchSelect(e.target.value)}
                    style={styles.branchSelect}
                    aria-label="Select branch"
                  >
                    {branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    {branches.length === 0 && (
                      <option value={wikiBranch}>{wikiBranch}</option>
                    )}
                    {branches.length > 0 && !branches.includes(wikiBranch) && (
                      <option value={wikiBranch}>{wikiBranch}</option>
                    )}
                  </select>
                </div>
                <div style={styles.dropdownDivider} />
                <button
                  type="button"
                  style={{
                    ...styles.rebuildButton,
                    ...(rebuilding ? styles.rebuildButtonDisabled : {}),
                  }}
                  onClick={handleRebuild}
                  disabled={rebuilding}
                >
                  {rebuilding ? 'Rebuilding…' : 'Rebuild all'}
                </button>
              </div>
            )}
          </div>
        )}
        {syncWarning && (
          <span
            role="status"
            aria-label={`Warning: ${syncWarning}`}
            title={syncWarning}
            style={styles.syncWarning}
          >
            ⚠ {syncWarning}
          </span>
        )}
        <a href={REPO_URL} target="_blank" rel="noreferrer" style={styles.repoLink}>
          SonicDMG/walfly ↗
        </a>
      </header>

      {/* ── Body ── */}
      <div ref={containerRef} style={styles.body}>

        {/* Left: TOC nav */}
        <nav style={{ ...styles.tocPane, ...(tocCollapsed ? styles.tocPaneCollapsed : {}) }}>
          <div style={styles.panelHeader}>
            {!tocCollapsed && <span style={styles.panelHeading}>Topics</span>}
            <button
              type="button"
              onClick={() => setTocCollapsed((v) => !v)}
              style={styles.collapseBtn}
              title={tocCollapsed ? 'Expand topics' : 'Collapse topics'}
              aria-label={tocCollapsed ? 'Expand topics panel' : 'Collapse topics panel'}
            >
              {tocCollapsed ? '»' : '«'}
            </button>
          </div>
          {!tocCollapsed && (
            tocLoading ? (
              <div style={styles.tocLoading}>Loading topics…</div>
            ) : tocTopics.length === 0 ? (
              <div style={styles.tocLoading}>No topics available.</div>
            ) : (
              tocTopics.map((topic, idx) => (
                <div key={idx}>
                  {topic.section && topic.section !== tocTopics[idx - 1]?.section && (
                    <div style={styles.tocSection}>{topic.section}</div>
                  )}
                  <button
                    style={{ ...styles.tocItem, ...(activeTopic === idx ? styles.tocItemActive : {}) }}
                    onClick={() => handleTopicClick(topic, idx)}
                    title={topic.description}
                    disabled={loading}
                  >
                    {topic.title}
                  </button>
                </div>
              ))
            )
          )}
        </nav>

        <div style={styles.tocDivider} />

        {/* Center: chat */}
        <div style={styles.chatPane}>
          <div style={styles.messageList}>
            {messages.map((msg) => (
              <MessageBlock
                key={msg.id}
                message={msg}
                isLatestAssistant={msg.id === latestAssistantMsg?.id}
                parsedLatest={parsedLatest}
                activeRef={activeRef}
                onCitationClick={handleCitationClick}
                loading={loading}
                onShowAs={(mode) => showAnswerAs(msg.id, mode)}
              />
            ))}
          </div>
        </div>

        {/* Drag handle (hidden when sidebar is collapsed) */}
        {!sidebarCollapsed && (
          <div style={styles.divider} onMouseDown={onDividerMouseDown} title="Drag to resize" />
        )}

        {/* Right: code reference sidebar */}
        <aside
          ref={sidebarRef}
          style={{
            ...styles.sidebar,
            ...(sidebarCollapsed ? styles.sidebarCollapsed : { width: sidebarWidth }),
            ...(resizing ? { transition: 'none' } : {}),
          }}
        >
          <div style={styles.panelHeader}>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((v) => !v)}
              style={styles.collapseBtn}
              title={sidebarCollapsed ? 'Expand references' : 'Collapse references'}
              aria-label={sidebarCollapsed ? 'Expand references panel' : 'Collapse references panel'}
            >
              {sidebarCollapsed ? '«' : '»'}
            </button>
            {!sidebarCollapsed && <span style={styles.panelHeading}>References</span>}
          </div>
          {!sidebarCollapsed && (
            <Sidebar
              refs={parsedLatest?.refs ?? []}
              activeRef={activeRef}
              onRefClick={(idx) => setActiveRef(idx)}
            />
          )}
        </aside>
      </div>

      {/* ── Input ── */}
      <footer style={styles.footer}>
        <div style={styles.modeRow}>
          <span style={styles.modeLabel}>Answer as</span>
          <ModeToggle value={answerMode} onChange={setAnswerMode} />
        </div>
        <div style={styles.inputRow}>
          <textarea
            ref={inputRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about any part of the codebase… (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={loading}
            autoFocus
          />
          <button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            style={styles.sendBtn}
          >
            {loading ? '…' : '→'}
          </button>
        </div>
        <p style={styles.hint}>Grounded in the current GitHub source — citations open in GitHub.</p>
      </footer>
    </div>
  );
}

// ── MessageBlock ───────────────────────────────────────────────────────────
//
// Wiki-style: a user question is a page title, the answer is the article
// beneath it. No chat bubbles.

interface MessageBlockProps {
  message: Message;
  isLatestAssistant: boolean;
  parsedLatest: ParsedMessage | null;
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
  loading: boolean;
  onShowAs: (mode: AnswerMode) => void;
}

function MessageBlock({
  message, isLatestAssistant, parsedLatest, activeRef, onCitationClick, loading, onShowAs,
}: MessageBlockProps) {
  if (message.role === 'user') {
    return <h1 id={`msg-${message.id}`} style={styles.question}>{message.content}</h1>;
  }
  const view = message.view ?? 'wiki';
  const answer = shownAnswer(message);
  const content = answer?.content ?? '';
  const streaming = !!answer?.pending;
  const proseClass = view === 'picture' ? 'md-prose md-picture' : 'md-prose';
  return (
    <article style={styles.answer}>
      {message.id !== 'welcome' && (
        <div style={styles.answerToolbar}>
          <ModeToggle
            value={view}
            onChange={onShowAs}
            // Generating the other version is a new request; wait for the current one.
            isDisabled={(mode) => loading && !message.answers?.[mode]}
            size="small"
          />
        </div>
      )}
      {!content ? (
        <span style={styles.pending}>
          {view === 'picture' ? 'Drawing the pictures…' : 'Reading the source…'}
        </span>
      ) : isLatestAssistant && parsedLatest ? (
        <ProseContent
          className={proseClass}
          prose={parsedLatest.prose}
          refs={parsedLatest.refs}
          commit={answer?.commit}
          streaming={streaming}
          activeRef={activeRef}
          onCitationClick={onCitationClick}
        />
      ) : (
        <MarkdownContent
          className={proseClass}
          content={parseMessage(content, answer?.commit).prose}
          commit={answer?.commit}
        />
      )}
    </article>
  );
}

// ── ModeToggle ─────────────────────────────────────────────────────────────

interface ModeToggleProps {
  value: AnswerMode;
  onChange: (mode: AnswerMode) => void;
  isDisabled?: (mode: AnswerMode) => boolean;
  size?: 'small' | 'normal';
}

function ModeToggle({ value, onChange, isDisabled, size = 'normal' }: ModeToggleProps) {
  return (
    <div role="radiogroup" aria-label="Answer style" style={styles.modeToggle}>
      {ANSWER_MODES.map(({ mode, label, title }) => {
        const active = mode === value;
        const disabled = !active && !!isDisabled?.(mode);
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={disabled ? 'Available once the current answer finishes' : title}
            disabled={disabled}
            onClick={() => onChange(mode)}
            style={{
              ...styles.modeBtn,
              ...(size === 'small' ? styles.modeBtnSmall : {}),
              ...(active ? styles.modeBtnActive : {}),
              ...(disabled ? styles.modeBtnDisabled : {}),
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Diagrams ───────────────────────────────────────────────────────────────
//
// The model describes diagrams as JSON (see the wiki chat prompt); we emit the
// Mermaid source. Every label is quoted/escaped and every id is generated here,
// so model output can't produce a Mermaid syntax error.

interface FlowNode { id: string; label?: string; group?: string }
interface FlowEdge { from: string; to: string; label?: string }
interface SequenceStep { from: string; to: string; label?: string; reply?: boolean }

const FLOW_DIRECTIONS = new Set(['LR', 'RL', 'TD', 'TB', 'BT']);

/** Escape text for use inside a quoted Mermaid label or message. */
function mmText(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\n', ' ')
    .replaceAll(';', '#59;')
    .replaceAll('"', '#quot;');
}

function diagramToMermaid(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return null;
  const d = spec as Record<string, unknown>;
  if (d.type === 'sequence' && Array.isArray(d.steps)) return sequenceToMermaid(d.actors, d.steps);
  if (Array.isArray(d.nodes)) return flowToMermaid(d.direction, d.nodes, d.edges);
  return null;
}

function flowToMermaid(direction: unknown, nodes: unknown[], edges: unknown): string {
  const ids = new Map<string, string>();
  const ungrouped: string[] = [];
  const groups = new Map<string, string[]>();

  const declare = (rawId: string, label: string, group?: string) => {
    if (ids.has(rawId)) return ids.get(rawId)!;
    const id = `n${ids.size}`;
    ids.set(rawId, id);
    const line = `${id}["${mmText(label)}"]`;
    if (group) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(line);
    } else {
      ungrouped.push(line);
    }
    return id;
  };

  for (const n of nodes as FlowNode[]) {
    if (typeof n?.id !== 'string') continue;
    declare(n.id, n.label || n.id, typeof n.group === 'string' ? n.group : undefined);
  }

  const edgeLines: string[] = [];
  for (const e of (Array.isArray(edges) ? edges : []) as FlowEdge[]) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') continue;
    const from = declare(e.from, e.from);
    const to = declare(e.to, e.to);
    edgeLines.push(e.label ? `${from} -->|"${mmText(e.label)}"| ${to}` : `${from} --> ${to}`);
  }

  const dir = FLOW_DIRECTIONS.has(String(direction)) ? String(direction) : 'LR';
  return [
    `flowchart ${dir}`,
    ...ungrouped,
    ...[...groups].flatMap(([name, members], i) => [`subgraph g${i}["${mmText(name)}"]`, ...members, 'end']),
    ...edgeLines,
  ].join('\n');
}

function sequenceToMermaid(actors: unknown, steps: unknown[]): string {
  const ids = new Map<string, string>();
  const participants: string[] = [];
  const declare = (name: string) => {
    if (ids.has(name)) return ids.get(name)!;
    const id = `p${ids.size}`;
    ids.set(name, id);
    participants.push(`participant ${id} as ${mmText(name)}`);
    return id;
  };

  for (const a of Array.isArray(actors) ? actors : []) {
    if (typeof a === 'string') declare(a);
  }
  const stepLines: string[] = [];
  for (const s of steps as SequenceStep[]) {
    if (typeof s?.from !== 'string' || typeof s?.to !== 'string') continue;
    const arrow = s.reply ? '-->>' : '->>';
    stepLines.push(`${declare(s.from)}${arrow}${declare(s.to)}: ${mmText(s.label ?? ' ')}`);
  }

  return ['sequenceDiagram', 'autonumber', ...participants, ...stepLines].join('\n');
}

/** Renders Mermaid source to an inline SVG. Waits until the answer has finished streaming. */
function MermaidBlock({ definition, streaming }: { definition: string | null; streaming: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (streaming || !definition) return;
    let cancelled = false;
    // Poll until mermaid is loaded from CDN (usually < 1 s).
    const tryRender = async () => {
      if (cancelled) return;
      if (!window.mermaid) {
        setTimeout(tryRender, 100);
        return;
      }
      // Unique id per render: mermaid leaves temp elements keyed by id in <body>.
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      try {
        const result = await window.mermaid.render(id, definition);
        if (!cancelled) {
          setError(null);
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram error');
      } finally {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    };
    void tryRender();
    return () => { cancelled = true; };
  }, [definition, streaming]);

  if (streaming || (!svg && !error && definition)) {
    return <div style={styles.diagramLoading}>drawing diagram…</div>;
  }
  if (error || !definition) {
    return (
      <details style={styles.diagramError}>
        <summary>Diagram couldn&apos;t be drawn{error ? ` — ${error}` : ''}</summary>
        {definition && <pre><code>{definition}</code></pre>}
      </details>
    );
  }
  return <ZoomableDiagram svg={svg!} />;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

/** Inline diagram with an expand button; the overlay lets the reader zoom and scroll. */
function ZoomableDiagram({ svg }: { svg: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Drag-to-pan: move the scroll position by the mouse delta (no re-render per move).
  const onPanStart = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el || e.button !== 0) return;
    // Let native scrollbar dragging work.
    const rect = el.getBoundingClientRect();
    if (e.clientX - rect.left >= el.clientWidth || e.clientY - rect.top >= el.clientHeight) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    setPanning(true);

    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const onUp = () => {
      setPanning(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const zoomBy = useCallback(
    (delta: number) => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta))),
    [],
  );

  // Wheel zoom, anchored on the cursor. Needs a native non-passive listener so
  // preventDefault() stops the overlay from scrolling instead of zooming.
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number; ratio: number } | null>(null);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const prev = zoomRef.current;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * Math.exp(-e.deltaY * 0.002)));
      if (next === prev) return;
      const rect = el.getBoundingClientRect();
      const ratio = next / prev;
      const pending = anchorRef.current;
      anchorRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        ratio: pending ? pending.ratio * ratio : ratio,
      };
      zoomRef.current = next;
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open]);

  // After the new size is laid out, keep the point under the cursor in place.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    anchorRef.current = null;
    const PAD = 20; // matches diagramScroll padding
    el.scrollLeft = (el.scrollLeft + a.x - PAD) * a.ratio + PAD - a.x;
    el.scrollTop = (el.scrollTop + a.y - PAD) * a.ratio + PAD - a.y;
  }, [zoom]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
      else if (e.key === '-') zoomBy(-ZOOM_STEP);
      else if (e.key === '0') setZoom(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, zoomBy]);

  const openOverlay = () => {
    setZoom(1);
    setOpen(true);
  };

  return (
    <div style={styles.diagramFrame}>
      <button
        type="button"
        onClick={openOverlay}
        style={styles.diagramExpandBtn}
        title="Zoom diagram"
        aria-label="Open diagram in zoom view"
      >
        ⤢
      </button>
      <figure
        style={styles.diagramWrapper}
        // mermaid output with securityLevel 'strict' — safe to set as innerHTML
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {open && (
        <div
          style={styles.diagramOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Diagram zoom view"
          onClick={() => setOpen(false)}
        >
          <div style={styles.diagramModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.diagramToolbar}>
              <button type="button" style={styles.diagramToolBtn} onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
              <span style={styles.diagramZoomLabel}>{Math.round(zoom * 100)}%</span>
              <button type="button" style={styles.diagramToolBtn} onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
              <button type="button" style={styles.diagramToolBtn} onClick={() => setZoom(1)} aria-label="Reset zoom">Reset</button>
              <button type="button" style={{ ...styles.diagramToolBtn, marginLeft: 'auto' }} onClick={() => setOpen(false)} aria-label="Close zoom view">✕</button>
            </div>
            <div
              ref={scrollRef}
              style={{ ...styles.diagramScroll, cursor: panning ? 'grabbing' : 'grab' }}
              onMouseDown={onPanStart}
            >
              <div
                className="diagram-zoom"
                style={{ width: `${zoom * 100}%`, margin: '0 auto' }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A ```diagram fence: parse the JSON spec (incomplete while streaming) and draw it. */
function DiagramBlock({ source, streaming }: { source: string; streaming: boolean }) {
  let definition: string | null = null;
  try {
    definition = diagramToMermaid(JSON.parse(source));
  } catch {
    // Partial JSON mid-stream, or malformed — MermaidBlock shows the right state.
  }
  return <MermaidBlock definition={definition} streaming={streaming} />;
}

// ── Picture cards ──────────────────────────────────────────────────────────
//
// Picture-book answers are built from ```picture fences holding one JSON card
// (see picturePrompt in the chat route). Cards cite code as "path:START-END";
// with the answer's commit that becomes the same permalink a Markdown citation
// would use, so it renders as a citation chip and lands in the sidebar.

interface PictureCite { url: string; label: string }

const CITE_SPEC = /^\s*([^\s:]+):(\d+)(?:-(\d+))?\s*$/;

function citeToRef(cite: unknown, commit: string | undefined): PictureCite | null {
  if (!commit || typeof cite !== 'string') return null;
  const m = cite.match(CITE_SPEC);
  if (!m) return null;
  const [, path, start, end = start] = m;
  return {
    url: `${REPO_URL}/blob/${commit}/${path}#L${start}-L${end}`,
    label: `${path.split('/').pop()}:${start}-${end}`,
  };
}

/** A card item's citation. Models sometimes put the "path:START-END" in `real` instead. */
function itemCite(item: Record<string, unknown>): unknown {
  if (item.cite !== undefined) return item.cite;
  return typeof item.real === 'string' && CITE_SPEC.test(item.real) ? item.real : undefined;
}

/** A cast member's real name, shortened to the file name when the model gave a path. */
function realName(value: unknown): string {
  const text = txt(value);
  const name = text.match(CITE_SPEC)?.[1] ?? text;
  return /^[^\s]+\/[^\s]+$/.test(name) ? name.split('/').pop()! : name;
}

/** Every citation in a card, in reading order. */
function pictureCites(spec: unknown): unknown[] {
  if (!spec || typeof spec !== 'object') return [];
  const d = spec as Record<string, unknown>;
  return [...list(d.members), ...list(d.panels)].map(itemCite).concat(d.cite);
}

/** Coerce a model-provided value to display text. */
function txt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}

interface PictureBlockProps {
  source: string;
  streaming: boolean;
  commit: string | undefined;
  anchor: AnchorOverride;
}

function PictureBlock({ source, streaming, commit, anchor }: PictureBlockProps) {
  let spec: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === 'object') spec = parsed as Record<string, unknown>;
  } catch {
    // Partial JSON mid-stream, or malformed.
  }
  if (!spec) {
    return streaming
      ? <div className="pic-loading">drawing a picture…</div>
      : <div className="pic-loading">This picture couldn&apos;t be drawn.</div>;
  }

  const cite = (value: unknown) => {
    const ref = citeToRef(value, commit);
    return ref ? <span className="pic-cite">{anchor({ href: ref.url, children: ref.label })}</span> : null;
  };

  switch (spec.type) {
    case 'analogy':
      return (
        <figure className="pic-card pic-analogy">
          <div className="pic-analogy-head">
            <span className="pic-emoji-xl" aria-hidden>{txt(spec.emoji) || '💡'}</span>
            <div>
              <div className="pic-kicker">Think of it like this</div>
              <div className="pic-title">{txt(spec.title)}</div>
              {txt(spec.text) && <div className="pic-text">{txt(spec.text)}</div>}
            </div>
          </div>
          {list(spec.pairs).length > 0 && (
            <div className="pic-pairs">
              {list(spec.pairs).map((p, i) => (
                <div key={i} className="pic-pair">
                  <span className="pic-emoji" aria-hidden>{txt(p.emoji)}</span>
                  <span className="pic-thing">{txt(p.thing)}</span>
                  <span className="pic-equals" aria-label="is">=</span>
                  <span className="pic-real">{txt(p.is)}</span>
                </div>
              ))}
            </div>
          )}
        </figure>
      );

    case 'cast':
      return (
        <figure className="pic-card">
          <div className="pic-kicker">Meet the characters</div>
          <div className="pic-cast">
            {list(spec.members).map((m, i) => (
              <div key={i} className="pic-member">
                <span className="pic-emoji-lg" aria-hidden>{txt(m.emoji) || '🙂'}</span>
                <div className="pic-name">{txt(m.name)}</div>
                {txt(m.real) && <code className="pic-real-name" title={txt(m.real)}>{realName(m.real)}</code>}
                <div className="pic-text">{txt(m.job)}</div>
                {cite(itemCite(m))}
              </div>
            ))}
          </div>
        </figure>
      );

    case 'comic':
      return (
        <figure className="pic-card">
          <div className="pic-kicker">{txt(spec.title) || 'What happens'}</div>
          <div className="pic-comic">
            {list(spec.panels).map((p, i) => (
              <div key={i} className="pic-panel">
                <span className="pic-panel-num">{i + 1}</span>
                <span className="pic-emoji-lg" aria-hidden>{txt(p.emoji) || '✨'}</span>
                {txt(p.who) && <div className="pic-who">{txt(p.who)}</div>}
                <div className="pic-text">{txt(p.caption)}</div>
                {cite(itemCite(p))}
              </div>
            ))}
          </div>
          {txt(spec.repeat) && (
            <div className="pic-repeat"><span aria-hidden>🔁</span> {txt(spec.repeat)}</div>
          )}
        </figure>
      );

    case 'choice': {
      const branch = (value: unknown, kind: 'yes' | 'no') => {
        const b = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        return (
          <div className={`pic-branch pic-branch-${kind}`}>
            <span className="pic-branch-tag">{kind === 'yes' ? 'Yes' : 'No'}</span>
            <span className="pic-emoji-lg" aria-hidden>{txt(b.emoji)}</span>
            <div className="pic-text">{txt(b.text)}</div>
          </div>
        );
      };
      return (
        <figure className="pic-card pic-choice">
          <div className="pic-question">
            <span className="pic-emoji-lg" aria-hidden>{txt(spec.emoji) || '🤔'}</span>
            <div className="pic-title">{txt(spec.question)}</div>
            {cite(spec.cite)}
          </div>
          <div className="pic-branches">
            {branch(spec.yes, 'yes')}
            {branch(spec.no, 'no')}
          </div>
        </figure>
      );
    }

    default:
      return null;
  }
}

// ── Shared component overrides for react-markdown ─────────────────────────

type AnchorOverride = (props: { href?: string; children?: React.ReactNode }) => React.ReactElement;

const DIAGRAM_LANGS = new Set(['language-diagram', 'language-mermaid', 'language-picture']);

function buildComponents(streaming: boolean, commit: string | undefined, anchorOverride?: AnchorOverride) {
  const anchorFn: AnchorOverride = anchorOverride ?? (({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">{children}</a>
  ));
  return {
    a: anchorFn,
    // Diagrams render as figures, so drop the <pre> react-markdown wraps fences in.
    pre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
      if (isValidElement<{ className?: string }>(children) && DIAGRAM_LANGS.has(children.props.className ?? '')) {
        return <>{children}</>;
      }
      return <pre {...rest}>{children}</pre>;
    },
    code({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) {
      const text = String(children ?? '').trimEnd();
      if (className === 'language-diagram') return <DiagramBlock source={text} streaming={streaming} />;
      if (className === 'language-mermaid') return <MermaidBlock definition={text} streaming={streaming} />;
      if (className === 'language-picture') {
        return <PictureBlock source={text} streaming={streaming} commit={commit} anchor={anchorFn} />;
      }
      return <code className={className} {...rest}>{children}</code>;
    },
    table({ children }: { children?: React.ReactNode }) {
      return <div className="md-table-wrap"><table>{children}</table></div>;
    },
  };
}

// ── MarkdownContent — plain react-markdown render (older messages) ─────────

function MarkdownContent({ content, commit, className }: { content: string; commit?: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={buildComponents(false, commit)}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── ProseContent — latest message with clickable citation chips ────────────
//
// Citation links (GitHub line-range permalinks) render as chips that highlight
// the matching sidebar card. Other links render normally.

interface ProseContentProps {
  className: string;
  prose: string;
  commit?: string;
  refs: RefBlock[];
  streaming: boolean;
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function ProseContent({ className, prose, commit, refs, streaming, activeRef, onCitationClick }: ProseContentProps) {
  const refByUrl = new Map(refs.map((r) => [r.url, r]));

  const anchorOverride: AnchorOverride = ({ href, children = null }) => {
    const ref = href ? refByUrl.get(href) : undefined;
    if (ref) {
      const isActive = activeRef === ref.index;
      return (
        <button
          type="button"
          style={{ ...styles.citationSpan, ...(isActive ? styles.citationActive : {}) }}
          onClick={() => onCitationClick(ref.index)}
          title={`Show ${ref.label} in the references panel`}
        >
          {ref.label}
        </button>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" style={styles.link}>
        {children}
      </a>
    );
  };

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={buildComponents(streaming, commit, anchorOverride)}>
        {prose}
      </ReactMarkdown>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────

interface SidebarProps {
  refs: RefBlock[];
  activeRef: number | null;
  onRefClick: (idx: number) => void;
}

function Sidebar({ refs, activeRef, onRefClick }: SidebarProps) {
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (activeRef === null) return;
    const el = cardRefs.current.get(activeRef);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeRef]);

  if (refs.length === 0) {
    return (
      <div style={styles.sidebarEmpty}>
        <p style={styles.sidebarEmptyText}>
          Code references from the current answer will appear here.
          <br /><br />
          Click any citation in the answer to jump to it.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.sidebarContent}>
      {refs.map((ref) => (
        <RefCard
          key={ref.index}
          ref_={ref}
          isActive={activeRef === ref.index}
          onClick={() => onRefClick(ref.index)}
          cardRef={(el) => {
            if (el) cardRefs.current.set(ref.index, el);
            else cardRefs.current.delete(ref.index);
          }}
        />
      ))}
    </div>
  );
}

// ── RefCard ────────────────────────────────────────────────────────────────

interface RefCardProps {
  ref_: RefBlock;
  isActive: boolean;
  onClick: () => void;
  cardRef: (el: HTMLDivElement | null) => void;
}

function RefCard({ ref_, isActive, onClick, cardRef }: RefCardProps) {
  const codeRef = useRef<HTMLElement>(null);
  const [fetchedText, setFetchedText] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Always fetch the exact lines from GitHub raw content using the citation URL.
  useEffect(() => {
    if (fetchedText !== null || fetching) return;
    const rawUrl = githubBlobToRaw(ref_.url);
    if (!rawUrl) return;
    setFetching(true);
    fetch(rawUrl)
      .then((r) => r.text())
      .then((src) => setFetchedText(extractLines(src, ref_.url)))
      .catch(() => setFetchedText(''))
      .finally(() => setFetching(false));
  }, [ref_.url, fetchedText, fetching]);

  const displayText = fetchedText ?? '';

  // Detect language from the file extension for syntax highlighting.
  const ext = ref_.url.split('?')[0].split('#')[0].split('.').pop() ?? '';
  const lang = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
                 py: 'python', rs: 'rust', go: 'go', json: 'json', md: 'markdown' }[ext] ?? ext;

  useEffect(() => {
    if (displayText && codeRef.current && window.hljs) {
      window.hljs.highlightElement(codeRef.current);
    }
  }, [displayText]);

  const filename = ref_.label.replace(/[:\d-]+$/, '');

  return (
    <div
      ref={cardRef}
      style={{ ...styles.refCard, ...(isActive ? styles.refCardActive : {}) }}
      onClick={onClick}
    >
      <div style={styles.refCardHeader}>
        <a
          href={ref_.url}
          target="_blank"
          rel="noreferrer"
          style={styles.refCardFilenameLink}
          onClick={(e) => e.stopPropagation()}
        >
          {filename}
        </a>
        <a
          href={ref_.url}
          target="_blank"
          rel="noreferrer"
          style={styles.refCardLink}
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      </div>
      <pre style={styles.refCodeBlock}>
        {fetching ? (
          <code style={{ color: w.textFaint, fontStyle: 'italic' }}>loading…</code>
        ) : (
          <code ref={codeRef} className={lang ? `language-${lang}` : undefined}>
            {displayText}
          </code>
        )}
      </pre>
    </div>
  );
}

/** Convert a github.com blob URL to a raw.githubusercontent.com URL. */
function githubBlobToRaw(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    // pathname: /owner/repo/blob/branch/path/to/file.ext
    const [, owner, repo, , branch, ...rest] = pathname.split('/');
    if (!owner || !repo || !branch || rest.length === 0) return null;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`;
  } catch {
    return null;
  }
}

/** Extract the lines referenced by the #L<n> or #L<n>-L<m> anchor from source text. */
function extractLines(src: string, url: string): string {
  const lines = src.split('\n');
  const anchor = url.match(/#L(\d+)(?:-L(\d+))?$/);
  if (!anchor) return src.slice(0, 3000); // no anchor — show first ~100 lines
  const start = Math.max(1, parseInt(anchor[1], 10)) - 1;
  const end = anchor[2] ? Math.min(lines.length, parseInt(anchor[2], 10)) : start + 1;
  return lines.slice(start, end).join('\n');
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// Uses the same Markdown parser react-markdown does, so we never disagree with
// the renderer about what is a link or a fence. Collects every GitHub line-range
// link as a sidebar RefBlock (deduped by URL); RefCard fetches the lines live.

/** A GitHub permalink with a #L line anchor — i.e. a code citation. */
function isCodeCitation(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'github.com' && u.hash.startsWith('#L');
  } catch {
    return false;
  }
}

/**
 * gpt-oss sometimes cites in its native browsing style, 【path/to/file.ts:12-30】,
 * instead of a Markdown link — mostly when citing docs. Rewrite those to links.
 */
const NATIVE_CITATION = /【([^】\s]+?):(\d+)(?:-(\d+))?】/g;

function linkNativeCitations(markdown: string, commit: string | undefined): string {
  if (!commit) return markdown;
  const base = `${REPO_URL}/blob/${commit}`;
  return markdown.replace(NATIVE_CITATION, (_, path: string, start: string, end: string = start) => {
    const file = path.split('/').pop();
    return ` [${file}:${start}-${end}](${base}/${path}#L${start}-L${end})`;
  });
}

function parseMessage(rawContent: string, commit?: string): ParsedMessage {
  let prose = linkNativeCitations(rawContent, commit);
  let tree = mdParser.parse(prose) as Root;

  // Despite instructions, models sometimes wrap the whole answer in one
  // ```markdown fence. If that's the only node, render its contents instead.
  const only = tree.children.length === 1 ? tree.children[0] : null;
  if (only?.type === 'code' && (only.lang === 'markdown' || only.lang === 'md')) {
    prose = linkNativeCitations(only.value, commit);
    tree = mdParser.parse(prose) as Root;
  }

  const refs: RefBlock[] = [];
  const seen = new Set<string>();
  const addRef = (url: string, label: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    refs.push({ index: refs.length, label, url });
  };
  visit(tree, (node) => {
    if (node.type === 'link' && isCodeCitation(node.url)) {
      addRef(node.url, node.children.map((ch) => ('value' in ch ? ch.value : '')).join(''));
    } else if (node.type === 'code' && node.lang === 'picture') {
      let spec: unknown;
      try { spec = JSON.parse(node.value); } catch { return; }
      for (const value of pictureCites(spec)) {
        const ref = citeToRef(value, commit);
        if (ref) addRef(ref.url, ref.label);
      }
    }
  });

  return { prose, refs };
}

// ── Global markdown styles (injected once via a <style> tag) ───────────────
//
// react-markdown renders real HTML elements (p, h1, table, etc.) so we style
// them with a scoped CSS class rather than inline style objects.

const MD_CSS = `
.md-prose { color: #1a1a1f; font-size: 15.5px; line-height: 1.75; }
.md-prose > :first-child { margin-top: 0; }
.md-prose > :last-child { margin-bottom: 0; }
.md-prose p { margin: 0 0 1em; }
.md-prose h1, .md-prose h2 { font-family: Georgia, serif; font-weight: 700; color: #1a1a1f; }
.md-prose h1 { font-size: 22px; margin: 1.6em 0 0.5em; }
.md-prose h2 { font-size: 19px; margin: 1.8em 0 0.6em; padding-bottom: 6px; border-bottom: 1px solid #e2e4e8; }
.md-prose h3 { font-size: 15.5px; font-weight: 600; margin: 1.4em 0 0.4em; }
.md-prose strong { font-weight: 600; }

/* Bulleted lists: small amber dots */
.md-prose ul { list-style: none; margin: 0 0 1em; padding-left: 0; }
.md-prose ul > li { position: relative; padding-left: 20px; margin-bottom: 6px; }
.md-prose ul > li::before { content: ''; position: absolute; left: 4px; top: 0.7em; width: 6px; height: 6px; border-radius: 50%; background: #F5A623; }

/* Numbered lists: a step timeline */
.md-prose ol { list-style: none; counter-reset: step; margin: 0 0 1em; padding-left: 0; }
.md-prose ol > li { counter-increment: step; position: relative; padding: 0 0 18px 42px; }
.md-prose ol > li::before {
  content: counter(step); position: absolute; left: 0; top: 0.1em;
  width: 26px; height: 26px; border-radius: 50%;
  background: #fff7e6; border: 1px solid #fcd389; color: #92600a;
  font-size: 12.5px; font-weight: 700; line-height: 24px; text-align: center;
}
.md-prose ol > li::after { content: ''; position: absolute; left: 13px; top: 32px; bottom: 4px; width: 1px; background: #e2e4e8; }
.md-prose ol > li:last-child { padding-bottom: 4px; }
.md-prose ol > li:last-child::after { display: none; }
.md-prose li > p { margin: 0 0 0.4em; }

/* Blockquotes are callouts ("> **Note:** ...") */
.md-prose blockquote { margin: 0 0 12px; padding: 10px 14px; background: #fff7e6; border: 1px solid #fcd389; border-left: 4px solid #F5A623; border-radius: 6px; color: #3d3020; }
.md-prose blockquote p { margin: 0; }

.md-prose hr { border: none; border-top: 1px solid #e2e4e8; margin: 1.5em 0; }
.md-prose code { background: #f3f4f6; border-radius: 4px; padding: 1.5px 5px; font-size: 0.86em; font-family: ui-monospace,"SF Mono",Consolas,monospace; color: #1a1a1f; }
.md-prose pre { margin: 0 0 1em; padding: 12px 14px; background: #1E1E22; color: #e2e4e8; border-radius: 8px; overflow-x: auto; }
.md-prose pre code { background: none; padding: 0; color: inherit; font-size: 12.5px; }

.md-prose .md-table-wrap { overflow-x: auto; margin: 0 0 1em; border: 1px solid #e2e4e8; border-radius: 8px; }
.md-prose table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.5; }
.md-prose th { padding: 8px 14px; text-align: left; font-weight: 600; font-size: 11.5px; letter-spacing: 0.04em; text-transform: uppercase; color: #57606a; background: #f7f8fa; border-bottom: 1px solid #e2e4e8; }
.md-prose td { padding: 9px 14px; border-top: 1px solid #eef0f2; vertical-align: top; }
.md-prose td:first-child { white-space: nowrap; }

.md-prose a { color: #b7791f; text-decoration: none; border-bottom: 1px solid #fcd389; }
.md-prose a:hover { border-bottom-color: #F5A623; }
.md-prose figure svg { max-width: 100%; height: auto; }
.diagram-zoom svg { width: 100%; max-width: none !important; height: auto; }

/* Picture-book mode: bigger, friendlier text */
.md-picture { font-size: 17px; line-height: 1.7; }
.md-picture h2 { font-size: 20px; border-bottom: none; }
.md-picture ul > li { padding-left: 0; }
.md-picture ul > li::before { display: none; } /* the model starts each bullet with an emoji */

/* Picture cards */
.pic-card { margin: 4px 0 22px; padding: 18px 20px; background: #fff; border: 1px solid #e2e4e8; border-radius: 14px; }
.pic-loading { margin: 4px 0 22px; padding: 28px; color: #8b949e; font-style: italic; font-size: 13px; text-align: center; background: #f7f8fa; border: 1px dashed #e2e4e8; border-radius: 14px; }
.pic-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #92600a; margin-bottom: 12px; }
.pic-title { font-family: Georgia, serif; font-size: 19px; font-weight: 700; line-height: 1.35; color: #1a1a1f; }
.pic-text { font-size: 15px; line-height: 1.5; color: #3a3f47; }
.pic-emoji { font-size: 22px; line-height: 1; }
.pic-emoji-lg { display: block; font-size: 38px; line-height: 1.1; margin-bottom: 6px; }
.pic-emoji-xl { font-size: 64px; line-height: 1; flex-shrink: 0; }
.pic-cite { display: block; margin-top: 8px; }
.pic-cite a { font-family: ui-monospace,"SF Mono",Consolas,monospace; font-size: 12px; }

.pic-analogy { background: #fff7e6; border-color: #fcd389; }
.pic-analogy-head { display: flex; gap: 18px; align-items: center; }
.pic-analogy-head .pic-kicker { margin-bottom: 4px; }
.pic-analogy-head .pic-text { margin-top: 4px; }
.pic-pairs { display: grid; gap: 8px; margin-top: 16px; }
.pic-pair { display: grid; grid-template-columns: 30px minmax(0,1fr) 22px minmax(0,1fr); align-items: center; gap: 8px; padding: 8px 12px; background: #fff; border: 1px solid #fcd389; border-radius: 10px; font-size: 15px; }
.pic-thing { font-weight: 600; }
.pic-equals { text-align: center; color: #F5A623; font-weight: 800; font-size: 18px; }
.pic-real { color: #3a3f47; }

.pic-cast { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.pic-member { text-align: center; padding: 14px 10px; background: #f7f8fa; border-radius: 12px; }
.pic-name { font-weight: 700; font-size: 15.5px; }
.pic-real-name { display: inline-block; max-width: 100%; overflow-wrap: anywhere; margin: 4px 0 6px; font-size: 12px; background: #fff; border: 1px solid #e2e4e8; border-radius: 4px; padding: 1px 6px; font-family: ui-monospace,"SF Mono",Consolas,monospace; }
.pic-member .pic-text { font-size: 14px; }

.pic-comic { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; counter-reset: none; }
.pic-panel { position: relative; padding: 26px 12px 14px; text-align: center; background: #fff; border: 2px solid #1a1a1f; border-radius: 6px; box-shadow: 3px 3px 0 #fcd389; }
.pic-panel-num { position: absolute; top: -11px; left: 10px; width: 24px; height: 24px; border-radius: 50%; background: #F5A623; color: #1a1a1f; font-size: 12.5px; font-weight: 800; line-height: 24px; text-align: center; }
.pic-who { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #92600a; margin-bottom: 4px; }
.pic-panel .pic-text { font-size: 14px; }
.pic-repeat { margin-top: 14px; padding: 8px 12px; background: #f7f8fa; border-radius: 8px; font-size: 14px; color: #3a3f47; }

.pic-question { text-align: center; padding: 6px 0 14px; }
.pic-branches { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; position: relative; }
.pic-branch { position: relative; text-align: center; padding: 22px 12px 14px; border-radius: 12px; border: 1px solid; }
.pic-branch-yes { background: #edf7ee; border-color: #b7dfbb; }
.pic-branch-no { background: #fbeeee; border-color: #efc3c0; }
.pic-branch-tag { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; line-height: 20px; color: #fff; }
.pic-branch-yes .pic-branch-tag { background: #2e7d32; }
.pic-branch-no .pic-branch-tag { background: #b3261e; }

@media (max-width: 560px) {
  .pic-analogy-head { flex-direction: column; text-align: center; }
  .pic-branches { grid-template-columns: 1fr; gap: 18px; }
}
`;

function GlobalMdStyles() {
  return <style dangerouslySetInnerHTML={{ __html: MD_CSS }} />;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const w = {
  bg:          '#ffffff',
  surface:     '#f7f8fa',
  border:      '#e2e4e8',
  text:        '#1a1a1f',
  textMuted:   '#57606a',
  textFaint:   '#8b949e',
  amber:       c.amber,
  amberLight:  '#fff7e6',
  amberBorder: '#fcd389',
  codeBg:      '#1E1E22',
  codeBorder:  '#2A2A2F',
  codeText:    '#e2e4e8',
} as const;

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100dvh',
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    fontSize: '15px',
    lineHeight: 1.65,
    color: w.text,
    background: w.bg,
  },
  header: {
    borderBottom: `1px solid ${w.border}`,
    padding: '10px 20px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: w.bg,
  },
  title: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 700,
    fontSize: '17px',
    color: w.text,
    letterSpacing: '0.5px',
  },
  subtitle: { color: w.textMuted, fontSize: '13px', flex: 1 },
  repoLink:  { color: w.amber, textDecoration: 'none', fontSize: '12px' },
  syncPill: {
    fontSize: '11px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: w.textMuted,
    background: w.surface,
    border: `1px solid ${w.border}`,
    borderRadius: '999px',
    padding: '2px 10px',
    marginRight: '10px',
    whiteSpace: 'nowrap' as const,
  },
  syncPillUpdated: { background: w.amberLight, borderColor: w.amberBorder, color: '#92600a' },
  syncPillError: { color: '#b3261e', borderColor: '#f0b4af' },
  syncPillRateLimited: { background: w.amberLight, borderColor: w.amberBorder, color: '#92600a' },
  syncWarning: {
    fontSize: '11px',
    color: '#92600a',
    background: w.amberLight,
    border: `1px solid ${w.amberBorder}`,
    borderRadius: '4px',
    padding: '2px 8px',
    marginRight: '8px',
    maxWidth: '240px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  statusDropdown: {
    position: 'absolute' as const,
    top: 'calc(100% + 4px)',
    left: 0,
    background: w.bg,
    border: `1px solid ${w.border}`,
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
    padding: '6px',
    zIndex: 100,
    minWidth: '170px',
  },
  dropdownSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    padding: '4px',
  },
  branchLabel: {
    fontSize: '11px',
    fontWeight: 600,
    color: w.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  branchSelect: {
    width: '100%',
    padding: '4px 8px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: w.text,
    background: w.surface,
    border: `1px solid ${w.border}`,
    borderRadius: '4px',
    outline: 'none',
    cursor: 'pointer',
  },
  dropdownDivider: {
    height: '1px',
    background: w.border,
    margin: '4px 0',
  },
  rebuildButton: {
    display: 'block',
    width: '100%',
    padding: '6px 12px',
    fontSize: '12px',
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    color: w.text,
    background: 'none',
    border: 'none',
    borderRadius: '4px',
    textAlign: 'left' as const,
    cursor: 'pointer',
  },
  rebuildButtonDisabled: {
    color: w.textFaint,
    cursor: 'not-allowed',
  },
  body: { flex: 1, display: 'flex', overflow: 'hidden' },

  // TOC
  tocPane: {
    width: '220px',
    flexShrink: 0,
    overflowX: 'hidden' as const,
    overflowY: 'auto' as const,
    background: w.surface,
    borderRight: `1px solid ${w.border}`,
    paddingTop: '0',
    paddingBottom: '8px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    transition: 'width 0.22s ease',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    borderBottom: `1px solid ${w.border}`,
    flexShrink: 0,
    gap: '8px',
    marginBottom: '4px',
  },
  panelHeading: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    margin: 0,
    padding: 0,
    lineHeight: 1,
  },
  tocHeading: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    padding: '0 16px 8px',
  },
  tocSection: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    padding: '14px 16px 4px',
  },
  tocLoading: { padding: '8px 16px', fontSize: '13px', color: w.textFaint, fontStyle: 'italic' as const },
  tocItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    paddingTop: '7px',
    paddingBottom: '7px',
    paddingLeft: '16px',
    paddingRight: '16px',
    background: 'none',
    borderTop: 'none',
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
    fontSize: '13px',
    color: w.textMuted,
    cursor: 'pointer',
    lineHeight: 1.4,
  },
  tocItemActive: {
    background: w.amberLight,
    color: '#92600a',
    fontWeight: 600,
    borderLeft: `3px solid ${w.amber}`,
    paddingLeft: '13px',
  },
  tocPaneCollapsed: {
    width: '44px',
    paddingTop: '8px',
    paddingBottom: '8px',
  },
  tocDivider: { width: '1px', flexShrink: 0, background: w.border },
  // Collapse toggle button — small rounded square, sits inline in the panel header
  collapseBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    background: w.bg,
    border: `1px solid ${w.border}`,
    borderRadius: '6px',
    cursor: 'pointer',
    color: w.textMuted,
    fontSize: '13px',
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
    flexShrink: 0,
  },

  // Reading pane — a centred article column keeps line length readable.
  chatPane: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '32px 40px 64px',
    minWidth: 0,
    background: w.bg,
  },
  messageList: {
    display: 'flex',
    flexDirection: 'column' as const,
    maxWidth: '760px',
    margin: '0 auto',
  },
  divider: { width: '4px', flexShrink: 0, cursor: 'col-resize', background: w.border },

  // Questions read as page titles; answers as the article beneath.
  question: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '26px',
    fontWeight: 700,
    lineHeight: 1.3,
    color: w.text,
    margin: '48px 0 20px',
    paddingTop: '32px',
    borderTop: `1px solid ${w.border}`,
    scrollMarginTop: '16px',
  },
  answer: { minWidth: 0 },
  answerToolbar: { display: 'flex', justifyContent: 'flex-end', margin: '-8px 0 16px' },

  // Answer-mode toggle (footer default + per-answer switch)
  modeRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
  modeLabel: { fontSize: '11px', color: w.textFaint },
  modeToggle: {
    display: 'inline-flex',
    padding: '2px',
    background: w.surface,
    border: `1px solid ${w.border}`,
    borderRadius: '999px',
  },
  modeBtn: {
    padding: '3px 12px',
    border: 'none',
    borderRadius: '999px',
    background: 'none',
    color: w.textMuted,
    fontSize: '12.5px',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    cursor: 'pointer',
  },
  modeBtnSmall: { padding: '2px 10px', fontSize: '12px' },
  modeBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  modeBtnActive: {
    background: w.bg,
    color: '#92600a',
    fontWeight: 600,
    boxShadow: `0 0 0 1px ${w.amberBorder}`,
  },
  pending: { color: w.textMuted, fontStyle: 'italic' as const },

  // Citation chips
  citationSpan: {
    display: 'inline-block',
    padding: '0 6px',
    borderRadius: '4px',
    background: w.surface,
    border: `1px solid ${w.border}`,
    color: '#92600a',
    fontSize: '11.5px',
    lineHeight: '18px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'baseline' as const,
    margin: '0 2px',
  },
  citationActive: {
    background: w.amber,
    border: `1px solid ${w.amber}`,
    color: '#1a1a1f',
  },
  link: { color: w.amber, textDecoration: 'none' },

  // Sidebar
  sidebar: {
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
    background: w.surface,
    borderLeft: `1px solid ${w.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    transition: 'width 0.22s ease',
    flexShrink: 0,
  },
  sidebarCollapsed: {
    width: '44px',
    overflowY: 'hidden' as const,
  },
  sidebarEmpty: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px' },
  sidebarEmptyText: { color: w.textFaint, fontSize: '13px', textAlign: 'center' as const, lineHeight: 1.7, margin: 0 },
  sidebarContent: { padding: '16px', display: 'flex', flexDirection: 'column' as const, gap: '12px' },
  sidebarHeading: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
  },

  // Ref cards
  refCard: {
    borderRadius: '8px',
    border: `1px solid ${w.border}`,
    background: w.bg,
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  refCardActive: { border: `2px solid ${w.amber}`, boxShadow: `0 0 0 3px ${c.amberGlow}` },
  refCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 12px',
    borderBottom: `1px solid ${w.codeBorder}`,
    background: w.codeBg,
  },
  refCardFilename: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    color: w.codeText,
    fontWeight: 500,
  },
  refCardFilenameLink: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    color: w.codeText,
    fontWeight: 500,
    textDecoration: 'none',
  },
  refCardLink: { fontSize: '11px', color: w.amber, textDecoration: 'none' },
  refCodeBlock: {
    margin: 0,
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
    overflowX: 'auto' as const,
    maxHeight: '320px',
    overflowY: 'auto' as const,
    background: w.codeBg,
    borderRadius: '0 0 8px 8px',
  },

  // Footer
  footer: { borderTop: `1px solid ${w.border}`, padding: '12px 20px', flexShrink: 0, background: w.bg },
  inputRow: { display: 'flex', gap: '8px' },
  textarea: {
    flex: 1,
    padding: '10px 14px',
    border: `1px solid ${w.border}`,
    borderRadius: '20px',
    fontSize: '14px',
    lineHeight: 1.5,
    fontFamily: 'inherit',
    resize: 'none' as const,
    outline: 'none',
    background: w.surface,
    color: w.text,
  },
  sendBtn: {
    width: '38px',
    height: '38px',
    borderRadius: '50%',
    background: w.amber,
    color: '#1a1a1f',
    border: 'none',
    fontSize: '18px',
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { margin: '6px 0 0', fontSize: '11px', color: w.textFaint },

  // ── Diagrams ──
  diagramFrame: { position: 'relative' as const },
  diagramExpandBtn: {
    position: 'absolute' as const,
    top: '8px',
    right: '8px',
    zIndex: 1,
    width: '28px',
    height: '28px',
    border: `1px solid ${w.border}`,
    borderRadius: '6px',
    background: w.surface,
    color: w.textMuted,
    fontSize: '15px',
    lineHeight: 1,
    cursor: 'pointer',
  },
  diagramOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  diagramModal: {
    display: 'flex',
    flexDirection: 'column' as const,
    width: '100%',
    height: '100%',
    background: w.bg,
    borderRadius: '10px',
    overflow: 'hidden',
  },
  diagramToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: `1px solid ${w.border}`,
    background: w.surface,
  },
  diagramToolBtn: {
    minWidth: '32px',
    height: '28px',
    padding: '0 10px',
    border: `1px solid ${w.border}`,
    borderRadius: '6px',
    background: w.bg,
    color: w.text,
    fontSize: '14px',
    cursor: 'pointer',
  },
  diagramZoomLabel: { minWidth: '48px', textAlign: 'center' as const, fontSize: '13px', color: w.textMuted },
  diagramScroll: { flex: 1, overflow: 'auto' as const, padding: '20px' },
  diagramWrapper: {
    margin: '4px 0 20px',
    padding: '20px',
    background: w.bg,
    border: `1px solid ${w.border}`,
    borderRadius: '10px',
    overflowX: 'auto' as const,
    textAlign: 'center' as const,
  },
  diagramLoading: {
    margin: '4px 0 20px',
    padding: '28px',
    color: w.textFaint,
    fontStyle: 'italic' as const,
    fontSize: '13px',
    textAlign: 'center' as const,
    background: w.surface,
    border: `1px dashed ${w.border}`,
    borderRadius: '10px',
  },
  diagramError: {
    margin: '4px 0 20px',
    padding: '10px 14px',
    background: w.surface,
    border: `1px solid ${w.border}`,
    borderRadius: '8px',
    fontSize: '12.5px',
    color: w.textMuted,
  },
} as const;

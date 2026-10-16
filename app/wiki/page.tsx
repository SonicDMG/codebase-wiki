'use client';

/**
 * /wiki — Live Walfly Codebase Q&A
 *
 * Three-column layout:
 *   Left   — persistent TOC nav (auto-generated topics)
 *   Center — prose answers rendered with react-markdown + remark-gfm
 *   Right  — code reference sidebar; clicking a citation highlights the card
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

/** A code block extracted from the LLM response, shown in the sidebar. */
interface RefBlock {
  index: number;
  lang: string;
  text: string;
  label: string; // e.g. "llm.ts:24"
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
      content:
        'Hi! Ask me anything about the Walfly codebase. I read the current source directly from GitHub, so my answers always reflect the latest code.\n\nClick any topic in the left panel to get started, or type your own question below.',
    },
  ]);
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

  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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
          theme: 'neutral',
          securityLevel: 'loose',
          // Don't inject the "Syntax error" bomb SVG into document.body.
          suppressErrorRendering: true,
        });
      document.head.appendChild(script);
    }
  }, []);

  // ── Drag-to-resize sidebar ────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const containerW = containerRef.current.offsetWidth;
      const delta = dragStartX.current - ev.clientX;
      const next = Math.min(Math.max(dragStartWidth.current + delta, 240), containerW - 320);
      setSidebarWidth(next);
    };
    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const latestAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

  // ── Send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading) return;

    if (!overrideQuestion) setInput('');
    setLoading(true);
    setActiveRef(null);

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: question };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', pending: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/wiki/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: wikiBranch ?? undefined,
          messages: history,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(err as { error?: string }).error ?? 'Unknown error'}`, pending: false }
              : m,
          ),
        );
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
            const parsed = JSON.parse(data) as { token?: string; error?: string };
            if (parsed.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + `\n\nError: ${parsed.error}`, pending: false }
                    : m,
                ),
              );
            } else if (parsed.token) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + parsed.token } : m,
                ),
              );
            }
          } catch { /* partial line */ }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Network error: ${err instanceof Error ? err.message : String(err)}`, pending: false }
            : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)),
      );
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, wikiBranch]);

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

  const parsedLatest = latestAssistantMsg ? parseMessage(latestAssistantMsg.content) : null;

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
        <nav style={styles.tocPane}>
          <div style={styles.tocHeading}>Topics</div>
          {tocLoading ? (
            <div style={styles.tocLoading}>Loading topics…</div>
          ) : tocTopics.length === 0 ? (
            <div style={styles.tocLoading}>No topics available.</div>
          ) : (
            tocTopics.map((topic, idx) => (
              <button
                key={idx}
                style={{ ...styles.tocItem, ...(activeTopic === idx ? styles.tocItemActive : {}) }}
                onClick={() => handleTopicClick(topic, idx)}
                title={topic.description}
                disabled={loading}
              >
                {topic.title}
              </button>
            ))
          )}
        </nav>

        <div style={styles.tocDivider} />

        {/* Center: chat */}
        <div style={styles.chatPane}>
          <div style={styles.messageList}>
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isLatestAssistant={msg.id === latestAssistantMsg?.id}
                parsedLatest={parsedLatest}
                activeRef={activeRef}
                onCitationClick={(idx) => setActiveRef(idx)}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Drag handle */}
        <div style={styles.divider} onMouseDown={onDividerMouseDown} title="Drag to resize" />

        {/* Right: code reference sidebar */}
        <aside style={{ ...styles.sidebar, width: sidebarWidth, flexShrink: 0 }}>
          <Sidebar
            refs={parsedLatest?.refs ?? []}
            activeRef={activeRef}
            onRefClick={(idx) => setActiveRef(idx)}
          />
        </aside>
      </div>

      {/* ── Input ── */}
      <footer style={styles.footer}>
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

// ── MessageBubble ──────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
  isLatestAssistant: boolean;
  parsedLatest: ParsedMessage | null;
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function MessageBubble({ message, isLatestAssistant, parsedLatest, activeRef, onCitationClick }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  return (
    <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAssistant) }}>
      <div style={styles.bubbleRole}>{isUser ? 'You' : 'Wiki'}</div>
      {message.pending && !message.content ? (
        <span style={styles.pending}>thinking…</span>
      ) : isLatestAssistant && parsedLatest ? (
        <ProseContent
          prose={parsedLatest.prose}
          refs={parsedLatest.refs}
          activeRef={activeRef}
          onCitationClick={onCitationClick}
        />
      ) : (
        <MarkdownContent content={message.content} />
      )}
    </div>
  );
}

// ── MermaidBlock — renders a mermaid fence as an inline SVG diagram ────────

/**
 * Best-effort repair for common LLM mistakes: unquoted labels containing
 * parentheses etc. inside [...] nodes or |...| edge labels, and non-ASCII hyphens.
 */
function repairMermaid(def: string): string {
  return def
    .replace(/[\u2010\u2011\u2012\u2013]/g, '-')
    .replace(/\[([^\]"\n]*[(){}:/][^\]"\n]*)\]/g, '["$1"]')
    .replace(/\|([^|"\n]*[(){}:/][^|"\n]*)\|/g, '|"$1"|');
}

function MermaidBlock({ definition }: { definition: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Poll until mermaid is loaded from CDN (usually < 1 s).
    const tryRender = async () => {
      if (cancelled) return;
      if (!window.mermaid) {
        setTimeout(tryRender, 100);
        return;
      }
      // Unique id per attempt: mermaid leaves temp elements keyed by id in <body>.
      const attempt = async (src: string) => {
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        try {
          return await window.mermaid!.render(id, src);
        } finally {
          // Remove any temp/error SVG mermaid appended to the page body.
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
        }
      };
      try {
        let result;
        try {
          result = await attempt(definition);
        } catch (firstErr) {
          const repaired = repairMermaid(definition);
          if (repaired === definition) throw firstErr;
          result = await attempt(repaired);
        }
        if (!cancelled) {
          setError(null);
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram error');
      }
    };
    void tryRender();
    return () => { cancelled = true; };
  }, [definition]);

  if (error) {
    return (
      <pre style={styles.diagramError}>
        <code>{definition}</code>
        <span style={styles.diagramErrorMsg}>⚠ {error}</span>
      </pre>
    );
  }
  if (!svg) {
    return <div style={styles.diagramLoading}>rendering diagram…</div>;
  }
  return (
    <div
      style={styles.diagramWrapper}
      // mermaid returns a sanitised SVG string — safe to set as innerHTML
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ── Shared component overrides for react-markdown ─────────────────────────
//
// Handles mermaid fences (→ diagram) and all other code fences (→ hljs block).
// Receives an optional citation/link override for ProseContent.

type AnchorOverride = (props: { href?: string; children?: React.ReactNode }) => React.ReactElement;

function buildComponents(anchorOverride?: AnchorOverride) {
  const anchorFn: AnchorOverride = anchorOverride ?? (({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">{children}</a>
  ));
  return {
    a: anchorFn,
    code({ className, children, ...rest }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
      const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
      const isBlock = !('inline' in rest);
      const text = String(children ?? '').replace(/\n$/, '');

      if (lang === 'mermaid' && isBlock) {
        return <MermaidBlock definition={text} />;
      }
      return <code className={className} {...rest}>{children}</code>;
    },
  };
}

// ── MarkdownContent — plain react-markdown render (older messages) ─────────

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="md-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildComponents()}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── ProseContent — latest message with clickable citation spans ────────────
//
// The LLM emits citations as [label](github-url). We replace each file-ref
// citation with a styled <span> that highlights the matching sidebar card.
// Everything else is standard markdown rendered by react-markdown.

interface ProseContentProps {
  prose: string;
  refs: RefBlock[];
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function ProseContent({ prose, refs, activeRef, onCitationClick }: ProseContentProps) {
  const citationMap = new Map(refs.map((r) => [r.label, r.index]));

  const anchorOverride: AnchorOverride = ({ href, children = null }) => {
    const label = Array.isArray(children)
      ? children.map((ch) => (typeof ch === 'string' ? ch : '')).join('')
      : typeof children === 'string' ? children : String(children ?? '');
    const refIndex = citationMap.get(label);
    if (refIndex !== undefined) {
      const isActive = activeRef === refIndex;
      return (
        <span
          style={{ ...styles.citationSpan, ...(isActive ? styles.citationActive : {}) }}
          onClick={() => onCitationClick(refIndex)}
          title={`View ${label} in sidebar`}
        >
          {label}
        </span>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer" style={styles.link}>
        {children}
      </a>
    );
  };

  return (
    <div className="md-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildComponents(anchorOverride)}>
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
      <div style={styles.sidebarHeading}>References</div>
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

  // If the LLM cited this file without providing a code block, fetch the
  // relevant lines directly from GitHub raw content.
  useEffect(() => {
    if (ref_.text || fetchedText !== null || fetching) return;
    const rawUrl = githubBlobToRaw(ref_.url);
    if (!rawUrl) return;
    setFetching(true);
    fetch(rawUrl)
      .then((r) => r.text())
      .then((src) => {
        const lines = extractLines(src, ref_.url);
        setFetchedText(lines);
      })
      .catch(() => setFetchedText(''))
      .finally(() => setFetching(false));
  }, [ref_.url, ref_.text, fetchedText, fetching]);

  const displayText = ref_.text || fetchedText || '';

  useEffect(() => {
    if (displayText && codeRef.current && window.hljs) {
      window.hljs.highlightElement(codeRef.current);
    }
  }, [displayText]);

  const filename = ref_.label.replace(/:\d+$/, '');

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
        {fetching && !displayText ? (
          <code style={{ color: w.textFaint, fontStyle: 'italic' }}>loading…</code>
        ) : (
          <code ref={codeRef} className={ref_.lang ? `language-${ref_.lang}` : undefined}>
            {displayText}
          </code>
        )}
      </pre>
    </div>
  );
}

/** Convert a github.com blob URL to a raw.githubusercontent.com URL. */
function githubBlobToRaw(url: string): string | null {
  // https://github.com/owner/repo/blob/branch/path/file.ext#L10-L20
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+?)(?:#.*)?$/);
  if (!m) return null;
  const [, owner, repo, branch, path] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
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
// Scans for citation+fence pairs: [label](github-url#Lnn) immediately followed
// (with only whitespace between) by a fenced code block. Only those pairs are
// extracted — the code goes to the sidebar RefBlock, the citation stays as a
// markdown link in the prose. Everything else — bare code blocks, mermaid
// diagrams, code inside lists — is left completely verbatim so react-markdown
// receives intact, well-formed markdown.

function parseMessage(rawContent: string): ParsedMessage {
  const refs: RefBlock[] = [];

  // If the LLM wrapped its entire response in a single outer fence, unwrap it.
  const outerFenceMatch = rawContent.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```\s*$/);
  const content = outerFenceMatch ? outerFenceMatch[1] : rawContent;

  // Match: [label](github-url#Lnn)  <optional whitespace>  ```lang\ncode\n```
  // The code block part is optional — a citation with no fence still creates a
  // sidebar card that lazy-fetches its lines.
  const pairRe =
    /\[([^\]]+)\]\((https?:\/\/github\.com[^)]+[:#]L?\d+[^)]*)\)(\s*```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```)?/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let prose = '';

  while ((match = pairRe.exec(content)) !== null) {
    // Keep everything before this match verbatim.
    prose += content.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    const label = match[1];
    const url   = match[2];
    const lang  = (match[4] ?? '').toLowerCase();
    const text  = (match[5] ?? '').trimEnd();

    // Mermaid fences paired with a citation — treat as a diagram, not a sidebar card.
    if (lang === 'mermaid') {
      prose += `[${label}](${url})\n\`\`\`mermaid\n${text}\n\`\`\``;
      continue;
    }

    // Create the sidebar ref card. If there was no code block the card will
    // lazy-fetch the lines from GitHub raw content.
    const refIndex = refs.length;
    refs.push({ index: refIndex, lang, text, label, url });
    // Keep the citation link in prose so ProseContent can render it as an
    // interactive span; the code block is consumed into the sidebar.
    prose += `[${label}](${url})`;
  }

  // Append any remaining content verbatim.
  prose += content.slice(lastIndex);

  return { prose, refs };
}

// ── Global markdown styles (injected once via a <style> tag) ───────────────
//
// react-markdown renders real HTML elements (p, h1, table, etc.) so we style
// them with a scoped CSS class rather than inline style objects.

const MD_CSS = `
.md-prose { color: #1a1a1f; line-height: 1.7; }
.md-prose p  { margin: 0 0 0.75em; }
.md-prose p:last-child { margin-bottom: 0; }
.md-prose h1 { font-family: Georgia, serif; font-size: 20px; font-weight: 700; margin: 0.8em 0 0.3em; border-bottom: 1px solid #e2e4e8; padding-bottom: 4px; }
.md-prose h2 { font-family: Georgia, serif; font-size: 17px; font-weight: 700; margin: 0.8em 0 0.3em; }
.md-prose h3 { font-size: 15px; font-weight: 600; color: #57606a; margin: 0.6em 0 0.2em; }
.md-prose ul, .md-prose ol { margin: 0 0 0.75em; padding-left: 22px; }
.md-prose li { margin-bottom: 4px; }
.md-prose hr { border: none; border-top: 1px solid #e2e4e8; margin: 12px 0; }
.md-prose code { background: #f7f8fa; border: 1px solid #e2e4e8; border-radius: 3px; padding: 1px 5px; font-size: 13px; font-family: ui-monospace,"SF Mono",Consolas,monospace; color: #c2185b; }
.md-prose pre  { margin: 0 0 0.75em; border-radius: 6px; overflow-x: auto; }
.md-prose pre code { background: none; border: none; padding: 0; color: inherit; font-size: 12px; }
.md-prose blockquote { border-left: 3px solid #e2e4e8; margin: 0 0 0.75em; padding: 2px 0 2px 14px; color: #57606a; }
.md-prose strong { font-weight: 600; }
.md-prose em { font-style: italic; }
.md-prose table { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-bottom: 0.75em; }
.md-prose th { padding: 7px 12px; text-align: left; font-weight: 600; font-size: 12px; color: #57606a; background: #f7f8fa; border-bottom: 2px solid #e2e4e8; white-space: nowrap; }
.md-prose td { padding: 7px 12px; border-bottom: 1px solid #e2e4e8; vertical-align: top; }
.md-prose tr:nth-child(even) td { background: #f7f8fa; }
.md-prose a { color: #F5A623; text-decoration: none; }
.md-prose a:hover { text-decoration: underline; }
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
    overflowY: 'auto' as const,
    background: w.surface,
    borderRight: `1px solid ${w.border}`,
    padding: '16px 0',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  tocHeading: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    padding: '0 16px 8px',
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
  tocDivider: { width: '1px', flexShrink: 0, background: w.border },

  // Chat
  chatPane: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '20px 24px',
    minWidth: 0,
    background: w.bg,
  },
  messageList: { display: 'flex', flexDirection: 'column' as const, gap: '20px' },
  divider: { width: '4px', flexShrink: 0, cursor: 'col-resize', background: w.border },

  // Bubbles
  bubble: { borderRadius: '8px', padding: '12px 16px' },
  bubbleUser: {
    background: w.amberLight,
    border: `1px solid ${w.amberBorder}`,
    alignSelf: 'flex-end' as const,
    maxWidth: '80%',
    borderBottomRightRadius: '3px',
  },
  bubbleAssistant: {
    background: w.bg,
    border: `1px solid ${w.border}`,
    width: '100%',
    borderBottomLeftRadius: '3px',
  },
  bubbleRole: {
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    marginBottom: '6px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  pending: { color: w.textMuted, fontStyle: 'italic' as const },

  // Citation pills
  citationSpan: {
    display: 'inline-block',
    padding: '1px 7px',
    borderRadius: '4px',
    background: w.amberLight,
    border: `1px solid ${w.amberBorder}`,
    color: '#92600a',
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'middle' as const,
    margin: '0 2px',
  },
  citationActive: {
    background: w.amber,
    border: `1px solid ${w.amber}`,
    color: '#1a1a1f',
  },
  link: { color: w.amber, textDecoration: 'none' },

  // Sidebar
  sidebar: { overflowY: 'auto' as const, background: w.surface, borderLeft: `1px solid ${w.border}` },
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

  // ── Mermaid diagrams ──
  diagramWrapper: {
    margin: '8px 0',
    padding: '16px',
    background: w.surface,
    border: `1px solid ${w.border}`,
    borderRadius: '8px',
    overflowX: 'auto' as const,
    textAlign: 'center' as const,
  },
  diagramLoading: {
    padding: '16px',
    color: w.textFaint,
    fontStyle: 'italic' as const,
    fontSize: '13px',
  },
  diagramError: {
    margin: '8px 0',
    padding: '12px',
    background: '#fff5f5',
    border: '1px solid #fca5a5',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#7f1d1d',
    overflowX: 'auto' as const,
  },
  diagramErrorMsg: {
    display: 'block',
    marginTop: '6px',
    fontStyle: 'italic' as const,
  },
} as const;

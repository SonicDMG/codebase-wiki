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
 * The whole app runs in one of two modes, switched once in the header: 'wiki'
 * (technical pages, light amber theme) or 'picture' — the Field Guide, the
 * Lumentide guide style built from ```picture JSON cards, with the page,
 * topics and code panels on the night-sky theme. An answer missing in the
 * current mode is generated when its conversation is open.
 */

import { Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

// 'picture' is the Field Guide: the Lumentide guide style, for the whole app.
const ANSWER_MODES: { mode: AnswerMode; label: string; title: string }[] = [
  { mode: 'wiki', label: '📖 Wiki', title: 'Technical wiki pages' },
  { mode: 'picture', label: '🕹️ Field Guide', title: 'The real words and how things work, drawn in pictures' },
];
const MODE_STORAGE_KEY = 'walfly_wiki_mode';

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
  /** Assistant only: one answer per mode, each generated the first time the app is in that mode. */
  answers?: Partial<Record<AnswerMode, Answer>>;
}

function shownAnswer(m: Message | undefined, mode: AnswerMode): Answer | undefined {
  return m?.answers?.[mode];
}

/** What the server sees for a turn: the question, or the answer in the current mode. */
function toHistory(m: Message, mode: AnswerMode) {
  return { role: m.role, content: m.role === 'user' ? m.content : shownAnswer(m, mode)?.content ?? '' };
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
  slug: string;
  generatedPage?: string;
  generatedPagePicture?: string;
  pageCommitSha?: string;
}

type SyncState = 'idle' | 'syncing' | 'up-to-date' | 'updated' | 'error' | 'rate-limited';

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content: '',
  answers: {
    wiki: {
      content:
        '## Welcome\nAsk anything about the Walfly codebase. Answers are read **live from the GitHub source**, so they always match the current commit.\n\n- Pick a topic on the left for a guided overview\n- Or type your own question below\n- Switch the whole wiki between **📖 Wiki** (technical pages) and **🕹️ Field Guide** (the real words and how things work, in pictures) at the top right\n- Click a citation chip to see the exact code in the references panel',
    },
    picture: {
      content: [
        '{"type":"words","title":"Walfly Field Guide","words":[{"word":"Topic","color":"orange","means":"One part of the codebase, with a page already written for it."},{"word":"Citation","color":"cyan","means":"A link to the exact lines of code behind a picture."}]}',
        '{"type":"lesson","title":"Every topic has its own page","picture":{"kind":"flow","steps":[{"label":"Pick a topic","color":"orange","note":"on the left"},{"label":"Read its page","color":"green"},{"label":"Ask more","color":"cyan","note":"in the box below"}]},"lines":["Each topic keeps its own conversation.","Your follow-up questions stay with their topic."]}',
        '{"type":"lesson","title":"Pictures come from the real code","picture":{"kind":"compare","rows":[{"items":["Wiki"],"ok":true,"verdict":"Technical pages, for reading closely"},{"items":["Field Guide"],"ok":true,"verdict":"The same facts, drawn in pictures"}]},"lines":["Switch modes once, at the top right. Every page follows.","Click a **Citation** to see the code beside the page."],"rule":"Pages are read live from GitHub, so they match the current commit."}',
      ].map((card) => '```picture\n' + card + '\n```').join('\n\n'),
    },
  },
};

const GENERAL_KEY = 'general';
const CONVERSATIONS_STORAGE_KEY = 'walfly_wiki_conversations_v2';

function topicKey(branch: string | null, slug: string): string {
  return `${branch ?? ''}:${slug}`;
}

/**
 * A topic's conversation opens with its question and the page pre-generated
 * for it, so follow-ups and mode flips have the question in history.
 * Null when the page hasn't been generated yet.
 */
function topicOpening(topic: TocTopic): Message[] | null {
  if (!topic.generatedPage) return null;
  const commit = topic.pageCommitSha;
  const answers: Message['answers'] = { wiki: { content: topic.generatedPage, commit } };
  if (topic.generatedPagePicture) answers.picture = { content: topic.generatedPagePicture, commit };
  return [
    { id: `q-${topic.slug}`, role: 'user', content: topic.suggestedQuery },
    // A missing picture page is generated live the first time it's shown.
    { id: `page-${topic.slug}`, role: 'assistant', content: '', answers },
  ];
}

/** True while a conversation is still just the topic's opening page (no follow-ups). */
function isUntouchedOpening(list: Message[] | undefined, slug: string): boolean {
  return list?.length === 2 && list[0].id === `q-${slug}` && list[1].id === `page-${slug}`;
}

function loadConversations(): Record<string, Message[]> | null {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<string, Message[]>;
    for (const [key, list] of Object.entries(stored)) {
      // The welcome text belongs to this version of the page, not to the save.
      stored[key] = list.map((m) => (m.id === WELCOME_MESSAGE.id ? WELCOME_MESSAGE : m));
    }
    // An answer still pending when the page closed will never finish: drop it if empty, else settle it.
    for (const list of Object.values(stored)) {
      for (const m of list) {
        if (!m.answers) continue;
        for (const mode of Object.keys(m.answers) as AnswerMode[]) {
          const a = m.answers[mode];
          if (!a?.pending) continue;
          if (a.content) a.pending = false;
          else delete m.answers[mode];
        }
      }
    }
    return stored;
  } catch (err) {
    console.warn('[wiki] failed to restore conversations:', err);
    return null;
  }
}

function saveConversations(conversations: Record<string, Message[]>) {
  try {
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations));
  } catch (err) {
    console.warn('[wiki] failed to save conversations:', err);
  }
}

const SYNC_POLL_MS = 45_000;
const SYNC_POLL_CAP_MS = 300_000;

// ── Main component ─────────────────────────────────────────────────────────

export default function WikiPage() {
  // One conversation per topic (keyed `${branch}:${slug}`), plus GENERAL_KEY for free-form questions.
  const [conversations, setConversations] = useState<Record<string, Message[]>>({
    [GENERAL_KEY]: [WELCOME_MESSAGE],
  });
  const conversationsRestored = useRef(false);

  // Restore after mount, not in the initializer: the server render has no
  // localStorage, so reading it during render breaks hydration.
  useEffect(() => {
    const stored = loadConversations();
    if (stored) setConversations((prev) => ({ ...prev, ...stored }));
    conversationsRestored.current = true;
    try {
      const mode = localStorage.getItem(MODE_STORAGE_KEY);
      if (mode === 'wiki' || mode === 'picture') setAnswerMode(mode);
    } catch { /* storage unavailable: start in wiki mode */ }
  }, []);

  const changeMode = (mode: AnswerMode) => {
    setAnswerMode(mode);
    try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* not remembered */ }
  };

  useEffect(() => {
    if (conversationsRestored.current) saveConversations(conversations);
  }, [conversations]);

  // One mode for the whole app; every answer, topic and panel follows it.
  const [answerMode, setAnswerMode] = useState<AnswerMode>('wiki');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeRef, setActiveRef] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [tocTopics, setTocTopics] = useState<TocTopic[]>([]);
  const [tocLoading, setTocLoading] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
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
    setActiveSlug(null);
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

    // Picture-book mode uses the Lumentide guide fonts.
    if (!document.getElementById('picture-fonts')) {
      const fonts = document.createElement('link');
      fonts.id = 'picture-fonts';
      fonts.rel = 'stylesheet';
      fonts.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Nunito:wght@500;700;900&display=swap';
      document.head.appendChild(fonts);
    }

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
      script.onload = () => window.mermaid?.initialize(mermaidConfig('wiki'));
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

  const activeKey = activeSlug ? topicKey(wikiBranch, activeSlug) : GENERAL_KEY;
  const currentMessages = conversations[activeKey] ?? [];

  // When a new question is asked, bring it to the top of the reading pane.
  // Don't follow streaming tokens — the reader starts at the top of the answer.
  const lastQuestionId = [...currentMessages].reverse().find((m) => m.role === 'user')?.id;
  useEffect(() => {
    if (!lastQuestionId) return;
    document.getElementById(`msg-${lastQuestionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [lastQuestionId]);

  const handleCitationClick = (idx: number) => {
    setActiveRef(idx);
    setSidebarCollapsed(false);
  };

  const latestAssistantMsg = [...currentMessages].reverse().find((m) => m.role === 'assistant');

  // A sync can regenerate a topic's page. Swap it in for conversations that
  // are still just the opening page; once the reader has asked follow-ups,
  // their conversation is left alone.
  useEffect(() => {
    setConversations((prev) => {
      let next = prev;
      for (const topic of tocTopics) {
        const key = topicKey(wikiBranch, topic.slug);
        const list = prev[key];
        if (!isUntouchedOpening(list, topic.slug)) continue;
        const shown = list![1].answers;
        if (shown?.wiki?.content === topic.generatedPage && shown?.picture?.content === topic.generatedPagePicture) continue;
        const opening = topicOpening(topic);
        if (!opening) continue;
        if (next === prev) next = { ...prev };
        next[key] = opening;
      }
      return next;
    });
  }, [tocTopics, wikiBranch]);

  // ── Stream one answer (in one mode) into an assistant message ─────────────
  const streamAnswer = useCallback(async (
    activeKey: string,
    assistantId: string,
    mode: AnswerMode,
    history: { role: Message['role']; content: string }[],
  ) => {
    const patch = (fn: (a: Answer) => Answer) =>
      setConversations((prev) => {
        const list = prev[activeKey] || [];
        return {
          ...prev,
          [activeKey]: list.map((m) =>
            m.id === assistantId
              ? { ...m, answers: { ...m.answers, [mode]: fn(m.answers?.[mode] ?? { content: '' }) } }
              : m,
          ),
        };
      });

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
  // `key` overrides the active conversation — a topic click sends before its
  // activeSlug update has re-rendered.
  const send = useCallback(async (overrideQuestion?: string, key: string = activeKey) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading) return;

    if (!overrideQuestion) setInput('');

    const history = conversations[key] ?? [];
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: question };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', answers: {} };

    setConversations((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), userMsg, assistantMsg] }));
    await streamAnswer(key, assistantId, answerMode, [...history, userMsg].map((m) => toHistory(m, answerMode)));
  }, [input, loading, conversations, activeKey, answerMode, streamAnswer]);

  // ── Answers missing in the current mode are generated, one at a time ────
  // Switching modes (or opening a conversation) fills in, oldest first, every
  // answer the open conversation doesn't have yet in that mode.
  useEffect(() => {
    if (loading) return;
    const list = conversations[activeKey] ?? [];
    const idx = list.findIndex((m) => m.role === 'assistant' && m.id !== WELCOME_MESSAGE.id && !m.answers?.[answerMode]);
    if (idx < 0) return;
    // History ends with the question this message answers.
    void streamAnswer(activeKey, list[idx].id, answerMode, list.slice(0, idx).map((m) => toHistory(m, answerMode)));
  }, [answerMode, activeKey, conversations, loading, streamAnswer]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // Open the topic's own conversation; the first visit starts it with the
  // pre-generated page, or answers live if that page isn't generated yet.
  const handleTopicClick = (topic: TocTopic) => {
    setActiveSlug(topic.slug);
    const key = topicKey(wikiBranch, topic.slug);
    if (conversations[key]?.length) return;
    const opening = topicOpening(topic);
    if (opening) setConversations((prev) => ({ ...prev, [key]: opening }));
    else void send(topic.suggestedQuery, key);
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

  const latestAnswer = shownAnswer(latestAssistantMsg, answerMode);
  const parsedLatest = latestAnswer ? parseMessage(latestAnswer.content, latestAnswer.commit) : null;

  return (
    <div className="wiki-root" data-mode={answerMode} style={styles.root}>
      <AnswerModeContext.Provider value={answerMode}>
      <GlobalMdStyles />
      {/* ── Header ── */}
      <header style={styles.header}>
        <span
          style={{ ...styles.title, cursor: 'pointer' }}
          onClick={() => {
            if (loading) return;
            setActiveSlug(null);
          }}
          title="Return to general chat"
        >
          Walfly Wiki
        </span>
        <span style={styles.subtitle}> — live codebase Q&A</span>
        <ModeToggle value={answerMode} onChange={changeMode} />
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
                <div key={topic.slug}>
                  {topic.section && topic.section !== tocTopics[idx - 1]?.section && (
                    <div style={styles.tocSection}>{topic.section}</div>
                  )}
                  <button
                    style={{ ...styles.tocItem, ...(activeSlug === topic.slug ? styles.tocItemActive : {}) }}
                    onClick={() => handleTopicClick(topic)}
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
            {currentMessages.map((msg) => (
              <MessageBlock
                key={msg.id}
                message={msg}
                isLatestAssistant={msg.id === latestAssistantMsg?.id}
                parsedLatest={parsedLatest}
                activeRef={activeRef}
                onCitationClick={handleCitationClick}
                mode={answerMode}
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
      </AnswerModeContext.Provider>
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
  mode: AnswerMode;
}

function MessageBlock({
  message, isLatestAssistant, parsedLatest, activeRef, onCitationClick, mode,
}: MessageBlockProps) {
  if (message.role === 'user') {
    return <h1 id={`msg-${message.id}`} style={styles.question}>{message.content}</h1>;
  }
  const answer = shownAnswer(message, mode);
  const content = answer?.content ?? '';
  const streaming = !!answer?.pending;
  const proseClass = mode === 'picture' ? 'md-prose md-picture' : 'md-prose';
  return (
    <article style={styles.answer}>
      {!content ? (
        <span style={styles.pending}>
          {mode === 'picture' ? 'Drawing the pictures…' : 'Reading the source…'}
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
}

function ModeToggle({ value, onChange }: ModeToggleProps) {
  return (
    <div role="radiogroup" aria-label="Wiki style" style={styles.modeToggle}>
      {ANSWER_MODES.map(({ mode, label, title }) => {
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={title}
            onClick={() => onChange(mode)}
            style={{ ...styles.modeBtn, ...(active ? styles.modeBtnActive : {}) }}
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

/**
 * Mermaid config for a mode. Mermaid needs real colours (not CSS variables), so the
 * wiki gets its light amber look and the Field Guide the night-sky Lumentide look.
 */
function mermaidConfig(mode: AnswerMode): Record<string, unknown> {
  const base = {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    // Don't inject the "Syntax error" bomb SVG into document.body.
    suppressErrorRendering: true,
  };
  if (mode === 'picture') {
    const p = PALETTES.picture;
    return {
      ...base,
      fontFamily: '"Nunito", "Segoe UI", system-ui, sans-serif',
      flowchart: { curve: 'basis', padding: 14 },
      themeVariables: {
        primaryColor: p.amberLight,
        primaryBorderColor: '#5ef2ff',
        primaryTextColor: p.text,
        textColor: p.text,
        titleColor: p.text,
        lineColor: '#ffe066',
        clusterBkg: p.codeBg,
        clusterBorder: p.border,
        edgeLabelBackground: p.codeBg,
        actorBkg: p.amberLight,
        actorBorder: '#5ef2ff',
        actorTextColor: p.text,
        actorLineColor: p.amberBorder,
        signalColor: '#ffe066',
        signalTextColor: p.text,
        labelBoxBkgColor: p.amberLight,
        labelBoxBorderColor: p.border,
        labelTextColor: p.text,
        sequenceNumberColor: p.onAccent,
        noteBkgColor: p.surface,
        noteBorderColor: p.border,
        noteTextColor: p.text,
        fontSize: '15px',
      },
    };
  }
  const p = PALETTES.wiki;
  return {
    ...base,
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    flowchart: { curve: 'basis', padding: 12 },
    themeVariables: {
      primaryColor: p.amberLight,
      primaryBorderColor: p.amberBorder,
      primaryTextColor: p.text,
      lineColor: p.textFaint,
      clusterBkg: p.surface,
      clusterBorder: p.border,
      edgeLabelBackground: p.bg,
      actorBkg: p.amberLight,
      actorBorder: p.amberBorder,
      noteBkgColor: p.surface,
      fontSize: '13px',
    },
  };
}

/** The answer mode, so diagrams can draw themselves in the matching look. */
const AnswerModeContext = createContext<AnswerMode>('wiki');

/** Renders Mermaid source to an inline SVG. Waits until the answer has finished streaming. */
function MermaidBlock({ definition, streaming }: { definition: string | null; streaming: boolean }) {
  const mode = useContext(AnswerModeContext);
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
        window.mermaid.initialize(mermaidConfig(mode));
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
  }, [definition, streaming, mode]);

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
// Picture-book answers follow the Lumentide guide style: a "words to learn"
// header, numbered lessons (a claim heading, one picture, a few short lines,
// an optional rule), and a closing "whole thing in one breath". Each card is a
// ```picture fence holding one JSON object (see picturePrompt in prompts.ts).
// Pictures show the real mechanism — steps, splits, bars, works/doesn't rows —
// never an analogy. Cards cite code as "path:START-END"; with the answer's
// commit that becomes the same permalink a Markdown citation would use, so it
// renders as a citation chip and lands in the sidebar.

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

/** A `cite` value as single specs — models sometimes give a list, or several joined by commas. */
function citeSpecs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(citeSpecs);
  return typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
}

/** Every `cite` anywhere in a card, in reading order. */
function pictureCites(spec: unknown): string[] {
  if (Array.isArray(spec)) return spec.flatMap(pictureCites);
  if (!spec || typeof spec !== 'object') return [];
  return Object.entries(spec).flatMap(([key, value]) => (key === 'cite' ? citeSpecs(value) : pictureCites(value)));
}

/**
 * Parse a card's JSON, repairing the model's usual slip: an array left open
 * before the next key, as in `"lines":["a","b","cite":"x"}`. When a key turns
 * up inside an array, the array is closed at its last comma; brackets still
 * open at the end are closed too. Returns null when the card can't be read.
 */
function parseCard(source: string): Record<string, unknown> | null {
  const asCard = (text: string) => {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  };
  try {
    return asCard(source);
  } catch { /* try the repair */ }

  let out = '';
  const open: { ch: '[' | '{'; lastComma: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      // Copy the whole string, escapes included, so its contents aren't scanned.
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
      continue;
    }
    const top = open[open.length - 1];
    if (ch === ':' && top?.ch === '[' && top.lastComma >= 0) {
      out = `${out.slice(0, top.lastComma)}]${out.slice(top.lastComma)}`;
      open.pop();
    } else if (ch === ',' && top) {
      top.lastComma = out.length;
    } else if (ch === '[' || ch === '{') {
      open.push({ ch, lastComma: -1 });
    } else if (ch === ']' || ch === '}') {
      open.pop();
    }
    out += ch;
  }
  out += open.reverse().map((o) => (o.ch === '[' ? ']' : '}')).join('');
  try {
    return asCard(out);
  } catch {
    return null;
  }
}

/** Coerce a model-provided value to display text. */
function txt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The guide palette: one colour per concept, named by the model. */
const PIC_COLORS: Record<string, string> = {
  orange: '#ffb347', cyan: '#5ef2ff', purple: '#c77dff', green: '#7dff9a',
  yellow: '#ffe066', red: '#ff5d5d', blue: '#4fc3ff', grey: '#9aa5b8', gray: '#9aa5b8',
};
const PIC_FALLBACK_COLORS = ['#5ef2ff', '#ffb347', '#c77dff', '#7dff9a', '#ffe066', '#4fc3ff'];

function picColor(value: unknown, i = 0): string {
  return PIC_COLORS[txt(value).toLowerCase()] ?? PIC_FALLBACK_COLORS[i % PIC_FALLBACK_COLORS.length];
}

/** Card text: `code` and **bold** spans. */
function rich(value: unknown): React.ReactNode {
  const text = txt(value);
  if (!text) return null;
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    return part;
  });
}

/** The drawing inside a lesson. */
function LessonPicture({ spec, cite }: { spec: Record<string, unknown>; cite: (v: unknown) => React.ReactNode }) {
  switch (spec.kind) {
    // Steps in order, left to right, wrapping.
    case 'flow':
      return (
        <div className="pic-flow">
          {list(spec.steps).map((s, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="pic-flow-arrow" aria-hidden>→</span>}
              <div className="pic-flow-step" style={{ borderColor: picColor(s.color, i) }}>
                <div className="pic-flow-label" style={{ color: picColor(s.color, i) }}>{txt(s.label)}</div>
                {txt(s.note) && <div className="pic-small">{rich(s.note)}</div>}
                {cite(s.cite)}
              </div>
            </Fragment>
          ))}
        </div>
      );

    // One whole split into parts, drawn as squares (or a bar when there are many).
    case 'split': {
      const parts = list(spec.parts).map((p, i) => ({ label: txt(p.label), n: Math.max(0, Math.round(Number(p.count) || 0)), color: picColor(p.color, i) }));
      const total = parts.reduce((sum, p) => sum + p.n, 0);
      return (
        <div className="pic-split">
          {txt(spec.title) && <div className="pic-pixel-label">{txt(spec.title)}</div>}
          {total > 0 && total <= 24 ? (
            <div className="pic-squares">
              {parts.flatMap((p, i) => Array.from({ length: p.n }, (_, j) => (
                <span key={`${i}-${j}`} className="pic-square" style={{ background: p.color }} />
              )))}
            </div>
          ) : (
            <div className="pic-splitbar">
              {parts.map((p, i) => <span key={i} style={{ background: p.color, flexGrow: p.n || 1 }} />)}
            </div>
          )}
          <div className="pic-legend">
            {parts.map((p, i) => (
              <span key={i} style={{ color: p.color }}>{p.n} {p.label}</span>
            ))}
          </div>
        </div>
      );
    }

    // Comparable amounts as horizontal bars.
    case 'bars': {
      const bars = list(spec.bars);
      const max = Number(spec.max) || Math.max(1, ...bars.map((b) => Number(b.value) || 0));
      return (
        <div className="pic-bars">
          {txt(spec.title) && <div className="pic-pixel-label">{txt(spec.title)}</div>}
          {bars.map((b, i) => {
            const pct = Math.min(100, Math.max(0, ((Number(b.value) || 0) / max) * 100));
            return (
              <div key={i} className="pic-bar-row">
                <span className="pic-bar-name" style={{ color: picColor(b.color, i) }}>{txt(b.label)}</span>
                <span className="pic-bar-track"><span style={{ width: `${pct}%`, background: picColor(b.color, i) }} /></span>
                <span className="pic-bar-value">{txt(b.display) || txt(b.value)}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Rows of items with a verdict: this works, this doesn't.
    case 'compare':
      return (
        <div className="pic-compare">
          {list(spec.rows).map((r, i) => (
            <div key={i} className="pic-compare-row">
              <div className="pic-chips">
                {(Array.isArray(r.items) ? r.items : []).map((item, j) => (
                  <span key={j} className={`pic-chip ${r.ok === false ? 'pic-chip-bad' : 'pic-chip-good'}`}>{txt(item)}</span>
                ))}
              </div>
              <div className={r.ok === false ? 'pic-verdict-bad' : 'pic-verdict-good'}>{rich(r.verdict)}</div>
            </div>
          ))}
        </div>
      );

    // Layers, outermost first: what a request meets on the way in.
    case 'stack':
      return (
        <div className="pic-stack">
          {list(spec.layers).reduceRight<React.ReactNode>((inner, layer, i) => (
            <div className="pic-layer" style={{ borderColor: picColor(layer.color, i) }}>
              <div className="pic-flow-label" style={{ color: picColor(layer.color, i) }}>{txt(layer.label)}</div>
              {txt(layer.note) && <div className="pic-small">{rich(layer.note)}</div>}
              {inner}
            </div>
          ), null)}
        </div>
      );

    // A row of little cards: the kinds of a thing, side by side.
    case 'cards':
      return (
        <div className="pic-minicards">
          {list(spec.cards).map((c, i) => (
            <div key={i} className="pic-minicard">
              <div className="pic-minicard-head" style={{ color: picColor(c.color, i) }}>
                {txt(c.emoji) && <span aria-hidden>{txt(c.emoji)} </span>}{txt(c.title)}
              </div>
              <div className="pic-small">{rich(c.text)}</div>
              {cite(c.cite)}
            </div>
          ))}
        </div>
      );

    default:
      return null;
  }
}

interface PictureBlockProps {
  source: string;
  streaming: boolean;
  commit: string | undefined;
  anchor: AnchorOverride;
}

function PictureBlock({ source, streaming, commit, anchor }: PictureBlockProps) {
  // Mid-stream the JSON is partial; only repair a card once it's complete.
  let spec: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed && typeof parsed === 'object') spec = parsed as Record<string, unknown>;
  } catch {
    if (!streaming) spec = parseCard(source);
  }
  if (!spec) {
    return streaming
      ? <div className="pic-loading">drawing a picture…</div>
      : <div className="pic-loading">This picture couldn&apos;t be drawn.</div>;
  }

  const cite = (value: unknown) => {
    const refs = citeSpecs(value).map((c) => citeToRef(c, commit)).filter((r): r is PictureCite => !!r);
    if (refs.length === 0) return null;
    return (
      <span className="pic-cite">
        {refs.map((ref) => <Fragment key={ref.url}>{anchor({ href: ref.url, children: ref.label })}</Fragment>)}
      </span>
    );
  };

  switch (spec.type) {
    case 'words': {
      const words = list(spec.words);
      return (
        <header className="pic-words">
          {txt(spec.title) && <div className="pic-h1">{txt(spec.title)}</div>}
          <p className="pic-lede">
            {words.length === 1 ? 'One word' : `${words.length} words`} to learn:{' '}
            {words.map((wd, i) => (
              <Fragment key={i}>
                {i > 0 && (i === words.length - 1 ? ' and ' : ', ')}
                <b style={{ color: picColor(wd.color, i) }}>{txt(wd.word)}</b>
              </Fragment>
            ))}.
          </p>
          <div className="pic-minicards">
            {words.map((wd, i) => (
              <div key={i} className="pic-minicard">
                <div className="pic-minicard-head" style={{ color: picColor(wd.color, i) }}>{txt(wd.word)}</div>
                {txt(wd.real) && <code className="pic-real-name">{txt(wd.real)}</code>}
                <div className="pic-small">{rich(wd.means)}</div>
              </div>
            ))}
          </div>
        </header>
      );
    }

    case 'lesson':
      return (
        <section className="pic-lesson">
          <h3 className="pic-lesson-title">{txt(spec.title)}</h3>
          {txt(spec.say) && <p className="pic-say">{rich(spec.say)}</p>}
          {spec.picture !== undefined && (
            <figure className="pic-figure">
              <LessonPicture spec={obj(spec.picture)} cite={cite} />
              {txt(obj(spec.picture).caption) && <figcaption>{rich(obj(spec.picture).caption)}</figcaption>}
            </figure>
          )}
          {Array.isArray(spec.lines) && spec.lines.length > 0 && (
            <ul className="pic-lines">
              {spec.lines.map((line, i) => <li key={i}>{rich(line)}</li>)}
            </ul>
          )}
          {txt(spec.rule) && <div className="pic-rule">{rich(spec.rule)}</div>}
          {cite(spec.cite)}
        </section>
      );

    case 'breath':
      return (
        <section className="pic-lesson pic-breath">
          <h3 className="pic-breath-title">The whole thing in one breath</h3>
          <p className="pic-big">{rich(spec.text)}</p>
        </section>
      );

    default:
      return <div className="pic-loading">This picture uses an older format. Ask again to redraw it.</div>;
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
      const spec = parseCard(node.value);
      if (!spec) return;
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

/* Field Guide mode: the Lumentide guide look — a night-sky comic column of
   dark lesson panels, pixel-font headings, one colour per concept. The page
   around it switches palette with the mode (THEME_CSS). */
.md-picture {
  color: #f3f5ff;
  font-family: "Nunito","Segoe UI",system-ui,sans-serif; font-size: 18px; line-height: 1.45;
  display: grid; gap: 22px; counter-reset: lesson;
}
.md-picture > * { margin: 0; }
.md-picture p { color: #f3f5ff; }
.md-picture a { color: #5ef2ff; border-bottom-color: #26325a; }
.md-picture code { background: #1f2a48; color: #f3f5ff; border: none; border-radius: 4px; padding: 0 5px; font-size: 0.85em; }
.md-picture ul { margin: 0; padding-left: 22px; display: grid; gap: 6px; }
.md-picture ul > li { padding-left: 0; }
.md-picture ul > li::before { display: none; }
.md-picture li { list-style: disc; }

.pic-loading { padding: 24px; color: #a8b3d6; font-style: italic; font-size: 14px; text-align: center; background: #141c33; border: 2px dashed #26325a; border-radius: 10px; }
.pic-cite { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.pic-cite a { font-family: ui-monospace,"SF Mono",Consolas,monospace; font-size: 12px; }
.pic-small { font-size: 15px; line-height: 1.4; color: #f3f5ff; }
.pic-pixel-label { font-family: "Press Start 2P","Courier New",monospace; font-size: 10px; line-height: 1.6; color: #f3f5ff; margin-bottom: 10px; }

.pic-words { display: grid; gap: 12px; }
.pic-h1 { font-family: "Press Start 2P","Courier New",monospace; font-size: clamp(16px, 3.4vw, 22px); line-height: 1.5; color: #5ef2ff; text-wrap: balance; }
.pic-lede { color: #a8b3d6 !important; font-size: 19px; margin: 0; }
.pic-real-name { justify-self: start; max-width: 100%; overflow-wrap: anywhere; font-size: 12px !important; font-family: ui-monospace,"SF Mono",Consolas,monospace; }

.pic-lesson { background: #141c33; border: 3px solid #26325a; border-radius: 10px; padding: 18px; display: grid; gap: 14px; min-width: 0; }
.pic-lesson-title, .pic-breath-title { margin: 0 !important; border: none !important; padding: 0 !important; font-family: "Press Start 2P","Courier New",monospace; font-size: 13px !important; line-height: 1.7; letter-spacing: 0.02em; color: #ffb347 !important; text-wrap: balance; }
.pic-lesson-title::before { counter-increment: lesson; content: counter(lesson) ". "; }
.pic-say { font-weight: 700; margin: 0; }
.pic-lines { margin: 0; }
.pic-rule { border-left: 6px solid #7dff9a; padding: 8px 12px; background: #0a0f1d; border-radius: 0 8px 8px 0; font-weight: 700; }
.pic-big { font-weight: 900; font-size: 21px; margin: 0; }

.pic-figure { margin: 0; background: #0a0f1d; border-radius: 8px; padding: 14px; overflow-x: auto; }
.pic-figure figcaption { font-size: 15px; color: #a8b3d6; margin-top: 10px; }

.pic-flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
.pic-flow-step { flex: 1 1 120px; min-width: 0; background: #141c33; border: 3px solid; border-radius: 8px; padding: 10px; display: grid; gap: 4px; align-content: start; }
.pic-flow-label { font-family: "Press Start 2P","Courier New",monospace; font-size: 9.5px; line-height: 1.6; overflow-wrap: anywhere; }
.pic-flow-arrow { align-self: center; color: #ffe066; font-size: 22px; font-weight: 900; }

.pic-squares { display: flex; flex-wrap: wrap; gap: 6px; }
.pic-square { width: 34px; height: 34px; border-radius: 5px; }
.pic-splitbar { display: flex; height: 28px; border-radius: 6px; overflow: hidden; gap: 3px; }
.pic-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-family: "Press Start 2P","Courier New",monospace; font-size: 9.5px; line-height: 1.6; text-transform: uppercase; }

.pic-bars { display: grid; gap: 10px; }
.pic-bar-row { display: grid; grid-template-columns: minmax(70px, 28%) minmax(0, 1fr) auto; align-items: center; gap: 10px; font-weight: 900; font-size: 15px; }
.pic-bar-name { overflow-wrap: anywhere; }
.pic-bar-track { height: 24px; background: #1f2a48; border-radius: 6px; overflow: hidden; }
.pic-bar-track > span { display: block; height: 100%; border-radius: 6px; }
.pic-bar-value { color: #f3f5ff; min-width: 3ch; }

.pic-compare { display: grid; gap: 12px; }
.pic-compare-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.pic-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pic-chip { font-family: "Press Start 2P","Courier New",monospace; font-size: 8.5px; line-height: 1.6; padding: 10px 8px; min-width: 70px; text-align: center; background: #141c33; border-radius: 6px; border: 3px solid #8c94a1; color: #f3f5ff; }
.pic-chip-good { border-color: #7dff9a; }
.pic-verdict-good { color: #7dff9a; font-weight: 900; }
.pic-verdict-bad { color: #ff9e7a; font-weight: 900; }

.pic-stack { display: grid; }
.pic-layer { border: 3px dashed; border-radius: 12px; padding: 10px 12px; display: grid; gap: 8px; }
.pic-layer .pic-layer { border-style: solid; }

.pic-minicards { display: flex; flex-wrap: wrap; gap: 12px; }
.pic-minicard { flex: 1 1 160px; min-width: 0; background: #0a0f1d; border-radius: 8px; padding: 12px; display: grid; gap: 6px; align-content: start; }
.pic-lesson .pic-minicard { background: #141c33; }
.pic-minicard-head { font-family: "Press Start 2P","Courier New",monospace; font-size: 10px; line-height: 1.6; overflow-wrap: anywhere; }

@media (max-width: 560px) {
  .pic-flow-arrow { transform: rotate(90deg); flex-basis: 100%; text-align: center; }
}
@media (prefers-reduced-motion: no-preference) {
  .pic-rule { animation: pic-glow 1.6s ease-in-out 1; }
  @keyframes pic-glow { 0% { border-left-color: #26325a } 100% { border-left-color: #7dff9a } }
}
`;

function GlobalMdStyles() {
  return <style dangerouslySetInnerHTML={{ __html: THEME_CSS + MD_CSS }} />;
}

// ── Styles ─────────────────────────────────────────────────────────────────

// Every colour and font in the page styles is a CSS variable, set per mode on
// the root (THEME_CSS): the wiki's light amber look, or the Field Guide's
// night-sky Lumentide look. Mermaid needs real colours, so it reads the
// wiki palette directly.
const PALETTES = {
  wiki: {
    bg:          '#ffffff',
    surface:     '#f7f8fa',
    border:      '#e2e4e8',
    text:        '#1a1a1f',
    textMuted:   '#57606a',
    textFaint:   '#8b949e',
    amber:       c.amber,
    amberLight:  '#fff7e6',
    amberBorder: '#fcd389',
    amberGlow:   c.amberGlow,
    accentText:  '#92600a',
    onAccent:    '#1a1a1f',
    codeBg:      '#1E1E22',
    codeBorder:  '#2A2A2F',
    codeText:    '#e2e4e8',
    fontBody:    '-apple-system, "Segoe UI", system-ui, sans-serif',
    fontHeading: 'Georgia, "Times New Roman", serif',
    titleSize:   '17px',
    questionSize: '26px',
    questionLine: '1.3',
    fontLabel:   'inherit',
    panelBorder: '1px',
  },
  picture: {
    bg:          '#0b1020',
    surface:     '#141c33',
    border:      '#26325a',
    text:        '#f3f5ff',
    textMuted:   '#a8b3d6',
    textFaint:   '#7d88ad',
    amber:       '#ffb347',
    amberLight:  '#1f2a48',
    amberBorder: '#3a4a7a',
    amberGlow:   '#ffb34733',
    accentText:  '#ffe066',
    onAccent:    '#0b1020',
    codeBg:      '#0a0f1d',
    codeBorder:  '#26325a',
    codeText:    '#f3f5ff',
    fontBody:    '"Nunito", "Segoe UI", system-ui, sans-serif',
    fontHeading: '"Press Start 2P", "Courier New", monospace',
    titleSize:   '13px',
    questionSize: '17px',
    questionLine: '1.7',
    fontLabel:   '"Press Start 2P", "Courier New", monospace',
    panelBorder: '3px',
  },
} as const;

type PaletteKey = keyof typeof PALETTES.wiki;

const w = Object.fromEntries(
  (Object.keys(PALETTES.wiki) as PaletteKey[]).map((k) => [k, `var(--w-${k})`]),
) as Record<PaletteKey, string>;

const paletteVars = (mode: AnswerMode) =>
  Object.entries(PALETTES[mode]).map(([k, v]) => `--w-${k}: ${v};`).join(' ');

const THEME_CSS = `
.wiki-root { ${paletteVars('wiki')} }
.wiki-root[data-mode="picture"] { ${paletteVars('picture')} }
/* Field Guide scrollbars: square night-sky thumbs, like the lesson panels. */
.wiki-root[data-mode="picture"], .wiki-root[data-mode="picture"] * { scrollbar-width: thin; scrollbar-color: #3a4a7a #0b1020; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar { width: 14px; height: 14px; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-track { background: #0b1020; border-left: 3px solid #26325a; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-thumb { background: #3a4a7a; border: 3px solid #0b1020; border-radius: 0; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-thumb:hover { background: #5ef2ff; }
.wiki-root[data-mode="picture"] *::-webkit-scrollbar-corner { background: #0b1020; }
.wiki-root ::placeholder { color: var(--w-textFaint); }
`;

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100dvh',
    fontFamily: w.fontBody,
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
    fontFamily: w.fontHeading,
    fontWeight: 700,
    fontSize: w.titleSize,
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
  syncPillUpdated: { background: w.amberLight, borderColor: w.amberBorder, color: w.accentText },
  syncPillError: { color: '#b3261e', borderColor: '#f0b4af' },
  syncPillRateLimited: { background: w.amberLight, borderColor: w.amberBorder, color: w.accentText },
  syncWarning: {
    fontSize: '11px',
    color: w.accentText,
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
    fontFamily: 'inherit',
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
    fontFamily: w.fontLabel,
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
    color: w.accentText,
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

  // Reading pane — the article fills the pane's width.
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
    width: '100%',
  },
  divider: { width: '4px', flexShrink: 0, cursor: 'col-resize', background: w.border },

  // Questions read as page titles; answers as the article beneath.
  question: {
    fontFamily: w.fontHeading,
    fontSize: w.questionSize,
    fontWeight: 700,
    lineHeight: w.questionLine,
    color: w.text,
    margin: '48px 0 20px',
    paddingTop: '32px',
    borderTop: `1px solid ${w.border}`,
    scrollMarginTop: '16px',
  },
  answer: { minWidth: 0 },

  // Answer-mode toggle (footer default + per-answer switch)
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
  modeBtnActive: {
    background: w.bg,
    color: w.accentText,
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
    color: w.accentText,
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
    color: w.onAccent,
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
    fontFamily: w.fontLabel,
    fontSize: '10px',
    fontWeight: 600,
    color: w.textFaint,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
  },

  // Ref cards
  refCard: {
    borderRadius: '8px',
    border: `${w.panelBorder} solid ${w.border}`,
    background: w.bg,
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  refCardActive: { border: `2px solid ${w.amber}`, boxShadow: `0 0 0 3px ${w.amberGlow}` },
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
    color: w.onAccent,
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
    border: `${w.panelBorder} solid ${w.border}`,
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

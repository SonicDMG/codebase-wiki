/**
 * POST /api/wiki/chat
 *
 * Live codebase Q&A grounded in the current state of the GitHub repo.
 * No database, no embeddings, no staleness.
 *
 * Pipeline:
 *   1. Fetch the full file tree from GitHub (60 s in-memory cache).
 *   2. First LLM call (non-streaming): given the question + tree, select the
 *      10-15 most relevant file paths.
 *   3. Fetch those files live from GitHub raw content (always current).
 *   4. Second LLM call (streaming): answer the question from the file contents,
 *      with [filename:line] citations that link back to GitHub.
 *
 * The route is stateless: the client owns the conversation history and sends
 * the full message array on every turn, identical to /api/chat.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLlmModel, llmClient } from '@/lib/llm';
import { fetchFileContents, formatTreeForPrompt, getBranchHead, getFileTree } from '@/lib/github';

export const runtime = 'nodejs';
export const maxDuration = 120;

const REPO_OWNER = 'SonicDMG';
const REPO_NAME = 'walfly';
const DEFAULT_BRANCH = 'main';

const MAX_FILES_TO_FETCH = 15;
const MAX_FILE_CHARS = 8_000; // per-file content cap to stay within context budget
const MAX_HISTORY_MESSAGES = 10;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface WikiChatRequest {
  branch?: string;
  messages: ChatMessage[];
}

export async function POST(req: NextRequest) {
  let body: WikiChatRequest;
  try {
    body = (await req.json()) as WikiChatRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return NextResponse.json({ error: '`messages` must be a non-empty array' }, { status: 400 });
  }

  const history: ChatMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') {
      return NextResponse.json({ error: 'Each message needs a string `content`' }, { status: 400 });
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return NextResponse.json({ error: 'Each message role must be "user" or "assistant"' }, { status: 400 });
    }
    if (message.content.trim()) history.push({ role: message.role, content: message.content });
  }

  const lastUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content.trim();
  if (!lastUserMessage) {
    return NextResponse.json({ error: 'No user message to answer' }, { status: 400 });
  }

  let client: ReturnType<typeof llmClient>;
  let model: string;
  try {
    client = llmClient();
    model = getLlmModel();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'LLM is not configured' },
      { status: 500 },
    );
  }

  // ── Resolve the branch head commit ONCE; the whole request stays anchored to it ──
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : DEFAULT_BRANCH;
  let commitSha: string;
  try {
    const head = await getBranchHead(REPO_OWNER, REPO_NAME, branch);
    if (head.status === 'rate-limited') {
      return NextResponse.json({ error: 'GitHub rate limit reached — try again shortly' }, { status: 503 });
    }
    if (head.status !== 'ok') {
      return NextResponse.json({ error: `Could not resolve branch "${branch}"` }, { status: 502 });
    }
    commitSha = head.sha;
  } catch (err) {
    console.error('[wiki/chat] branch head resolution failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve branch head' },
      { status: 502 },
    );
  }

  // ── Stage 1: fetch file tree + select relevant files ──────────────────────
  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(lastUserMessage, client, model, commitSha);
  } catch (err) {
    console.error('[wiki/chat] context build failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build codebase context' },
      { status: 500 },
    );
  }

  // ── Stage 2: streaming answer ─────────────────────────────────────────────
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (payload: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));

      // The client needs the commit to turn bare 【path:A-B】 citations into permalinks.
      send({ commit: commitSha });

      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.slice(-MAX_HISTORY_MESSAGES),
          ],
          stream: true,
        });

        for await (const chunk of completion) {
          const token = chunk.choices[0]?.delta?.content ?? '';
          if (token) send({ token });
        }
      } catch (err) {
        send({ error: err instanceof Error ? err.message : 'LLM request failed' });
      } finally {
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Builds the grounded system prompt by:
 *   1. Fetching the file tree (cached 60 s)
 *   2. Asking the LLM which files are relevant to the question
 *   3. Fetching those files live from GitHub
 *   4. Assembling a system prompt with the file contents + citation instructions
 */
async function buildSystemPrompt(
  question: string,
  client: ReturnType<typeof llmClient>,
  model: string,
  commitSha: string,
): Promise<string> {
  const githubBase = `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${commitSha}`;

  // 1. File tree
  const entries = await getFileTree(REPO_OWNER, REPO_NAME, commitSha);
  const treeText = formatTreeForPrompt(entries);
  console.log(`[wiki/chat] tree has ${entries.length} files after filtering`);

  // 2. File selection — fast non-streaming call
  const selectionResponse = await client.chat.completions.create({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `You are a file selector for a code Q&A system.
Given a developer's question and a list of files in the Walfly monorepo, return ONLY a JSON array of up to ${MAX_FILES_TO_FETCH} file paths that are most likely to contain the answer.
Output ONLY valid JSON. No prose, no markdown fences. Example: ["packages/api/lib/llm.ts","apps/mobile/app/(tabs)/chat.tsx"]`,
      },
      {
        role: 'user',
        content: `Question: ${question}\n\nFile tree:\n${treeText}`,
      },
    ],
  });

  const rawSelection = selectionResponse.choices[0]?.message?.content?.trim() ?? '[]';
  let selectedPaths: string[] = [];
  try {
    // Strip markdown fences if the model wrapped the JSON anyway
    const cleaned = rawSelection.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      selectedPaths = parsed.filter((p): p is string => typeof p === 'string').slice(0, MAX_FILES_TO_FETCH);
    }
  } catch {
    console.warn('[wiki/chat] file selection parse failed, raw output:', rawSelection.slice(0, 200));
  }

  console.log(`[wiki/chat] selected ${selectedPaths.length} files:`, selectedPaths);

  if (selectedPaths.length === 0) {
    return FALLBACK_SYSTEM_PROMPT;
  }

  // 3. Fetch file contents live from GitHub
  const contents = await fetchFileContents(REPO_OWNER, REPO_NAME, selectedPaths, commitSha);
  const fetchedPaths = Object.keys(contents);
  console.log(`[wiki/chat] fetched ${fetchedPaths.length}/${selectedPaths.length} files`);

  if (fetchedPaths.length === 0) {
    return FALLBACK_SYSTEM_PROMPT;
  }

  // 4. Assemble system prompt. Lines are numbered so citations can use real
  // line ranges instead of the model counting lines itself.
  const filesBlock = fetchedPaths
    .map((path) => {
      const raw = contents[path];
      const text = raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) : raw;
      const numbered = text
        .split('\n')
        .map((line, i) => `${i + 1}| ${line}`)
        .join('\n');
      const truncated = text.length < raw.length ? '\n... [truncated]' : '';
      return `<file path="${path}">\n${numbered}${truncated}\n</file>`;
    })
    .join('\n\n');

  const example = `${githubBase}/packages/api/lib/llm.ts#L24-L42`;

  return `You are the Walfly codebase wiki (${REPO_OWNER}/${REPO_NAME} at commit ${commitSha}).
Your reader is a developer who is new to this codebase. Your job is to help them build an accurate mental
model quickly. Answer using ONLY the source files at the end of this prompt. If the answer is not there,
say so in one sentence and name the part of the codebase most likely to have it.

# Page format

Write a scannable wiki page, not an essay. Use this outline, dropping any section that does not fit the question:

## Overview
One or two sentences: what this is and why it exists. **Bold** the single most important concept.

(Then one diagram block — see "Diagrams". Always include one for overview, architecture, data-flow or
"how does X work" questions; skip it only for narrow questions about a single function or value.)

## How it works
A numbered list of 3–7 steps in the order things actually happen. Each step is
**A short bold title** — one or two sentences that end with a citation.

## Key files
A two-column table: | File | Responsibility |. One row per file, 3–8 rows. The File cell is a citation;
the Responsibility cell is a short phrase, not a sentence.

## Gotchas
Only if there is something non-obvious (limits, retries, failure modes, footguns). At most three, each
one a blockquote starting with **Note:**.

Style rules:
- No paragraph longer than three sentences. Prefer a list whenever you are enumerating.
- Use \`inline code\` for identifiers, file paths, env vars and endpoints.
- No preamble, no closing summary, no restating the question.
- For narrow follow-up questions, answer in the same style but use only the sections that help.
- Output Markdown directly. Never wrap the whole answer in a code fence. Never use HTML tags.
- Never include source code in the answer — the UI shows cited code beside the text automatically.

# Citations

Every mention of a specific function, type, constant or block of code gets a citation link:
  [file.ts:START-END](${githubBase}/<path>#L<START>-L<END>)
- Use the line numbers printed at the start of each source line (the "N| " prefix).
- Always cite a range covering the whole function or block, never a single line.
- Use this exact commit SHA, never a branch name.
- Citations are ALWAYS Markdown links with the full URL. Never use 【】 or bare [file:lines] references —
  they are not clickable and the UI cannot show the code.
- Put the link straight into the sentence. Do not wrap it in extra brackets or parentheses.
Example: The client is a lazily created singleton [llm.ts:24-42](${example}).

# Diagrams

Diagrams are written as a fenced block with the language "diagram" containing JSON (not Mermaid). The UI
draws it. Use 4–12 nodes or steps, labels of at most five words. Two kinds:

Flow — architecture, pipelines, module dependencies. Optional "group" clusters related nodes.
\`\`\`diagram
{"type":"flow","direction":"LR","nodes":[{"id":"app","label":"Expo app","group":"Client"},{"id":"api","label":"Next.js API","group":"Server"},{"id":"db","label":"Astra DB","group":"Server"}],"edges":[{"from":"app","to":"api","label":"POST segments"},{"from":"api","to":"db","label":"insert"}]}
\`\`\`

Sequence — a request or process unfolding over time. "reply": true draws a dashed return arrow.
\`\`\`diagram
{"type":"sequence","actors":["App","API","Astra DB"],"steps":[{"from":"App","to":"API","label":"POST /finalize"},{"from":"API","to":"Astra DB","label":"update status"},{"from":"API","to":"App","label":"200 OK","reply":true}]}
\`\`\`

---

${filesBlock}

---

Reminder before you answer: follow the page format above; every citation is a Markdown link
[file:START-END](${githubBase}/<path>#L<START>-L<END>) — including for README and other docs — never 【】;
diagrams go in a \`\`\`diagram JSON block; no HTML, no source code.`;
}

const FALLBACK_SYSTEM_PROMPT = `You are a live documentation assistant for the Walfly codebase.
No file contents could be loaded for this question. Tell the user honestly and suggest they check the repository directly at https://github.com/${REPO_OWNER}/${REPO_NAME}.`;

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

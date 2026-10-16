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

  // 4. Assemble system prompt
  const filesBlock = fetchedPaths
    .map((path) => {
      const raw = contents[path];
      const text = raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n... [truncated]' : raw;
      return `### ${path}\n\`\`\`\n${text}\n\`\`\``;
    })
    .join('\n\n');

  return `You are a live documentation assistant for the Walfly codebase (${REPO_OWNER}/${REPO_NAME}) at commit ${commitSha}.
Answer developer questions using ONLY the file contents below.
If the answer is not in the provided files, say so and suggest which part of the codebase might have the answer.

CITATION RULES — follow these exactly, they drive the UI:
1. Every time you mention a specific function, type, constant, or block of code, you MUST cite it.
   Citation format: [filename:LINE](COMMIT_PERMALINK_WITH_LINE_ANCHOR)
   The URL MUST be a commit permalink of the form ${githubBase}/<path>#L<line> — use exactly this commit SHA (${commitSha}), never a branch name.
   Example: [llm.ts:24](${githubBase}/packages/api/lib/llm.ts#L24)

2. The citation MUST come BEFORE the code block — always in this exact order:
   prose text mentioning the function → [filename:LINE](url) → \`\`\`lang\\ncode\\n\`\`\`
   NEVER put the code block before the citation. NEVER put the citation after the code block.

3. Immediately after each citation, include a fenced code block with the relevant lines:
   \`\`\`typescript
   export function llmClient(): OpenAI { ... }
   \`\`\`

4. Cite every file you draw on. Multiple functions in the same file each get their own citation + code block.
5. Keep prose concise. Avoid filler phrases. Code blocks go to a sidebar — write as if the reader sees the code alongside the text.

DIAGRAM RULES:
6. When a question involves architecture, data flow, state machines, sequences, or component relationships,
   include a Mermaid diagram inline in your answer using a fenced code block:
   \`\`\`mermaid
   graph TD
     A[Client] --> B[API]
   \`\`\`
7. Prefer diagrams for: call flows, pipeline stages, database relationships, state transitions,
   class/module dependencies, and request/response sequences.
8. Keep diagrams focused — 5 to 15 nodes. Use descriptive labels.
   SYNTAX: ALWAYS wrap node labels and edge labels in double quotes, e.g. A["Local Buffer (OPFS)"] and
   A -->|"HTTPS (session, segments)"| B. Unquoted parentheses, slashes or colons inside labels break the parser.
   Use ASCII hyphens only (never non-breaking hyphens such as ‑) and <br> for line breaks.
9. Mermaid diagrams are rendered visually in the UI — do NOT wrap them in citation links.
   Place the diagram after the explanatory prose, before or after code citations.

---

${filesBlock}`;
}

const FALLBACK_SYSTEM_PROMPT = `You are a live documentation assistant for the Walfly codebase.
No file contents could be loaded for this question. Tell the user honestly and suggest they check the repository directly at https://github.com/${REPO_OWNER}/${REPO_NAME}.`;

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

# Wiki — Fast, Provably Fresh Code Search

> **Status:** draft for review. Open questions are in §10 and are being resolved
> one at a time.
>
> Related code: `lib/wiki/sync.ts` (snapshot diff + lease),
> `lib/wiki/store.ts` (Astra I/O), `lib/github.ts`,
> `app/api/wiki/chat/route.ts` (current answer path),
> `scripts/seed-wiki-topics.ts` (local seeding precedent).

## 1. Problem

`/api/wiki/chat` answers by (1) sending the whole file tree to an LLM to pick
files, then (2) fetching up to 15 of them from GitHub, then (3) streaming the
answer. It is always current, but:

- **It is slow.** Before the first token there is an uncached branch-head call, a
  tree fetch, a non-streaming LLM call, and up to 15 serial-ish raw fetches.
- **It is fragile.** File selection is a guess from path names alone.
- **It sees little.** Each file is cut to `MAX_FILE_CHARS` (8,000); the biggest
  wiki file is 86 KB, so most of it is never read.

Pre-indexed tools (DeepWiki) are fast but silently go stale: refresh is manual and
the only signal is a "Last indexed" line. We want index speed **and** a hard
freshness guarantee.

## 2. Goals / non-goals

**Goals**
1. **Speed.** Lower time-to-first-token. Replace the file-selector LLM call and the
   GitHub fetch fan-out with one Astra search and one Astra read.
2. **Freshness.** No answer cites stale code. Staleness is detected per question
   and the affected files are read live.
3. **Whole files.** Answers see entire files, not 8,000-char heads or fragments.
4. **Cheap incremental updates.** Only files whose git blob SHA changed are
   re-processed.
5. **Measured.** Every claim above is checked against a recorded baseline (§6,
   Phase 1).

**Non-goals (for now)**
- Indexing branches other than `main` (other branches degrade to live reads, §4.7).
- Changing topic generation/classification in `lib/wiki/*`.
- Cross-repo indexing.
- Chunk-level retrieval (revisit only if file-level proves too coarse, §9).

## 3. Facts the design rests on

- A git blob SHA is `sha1("blob " + byteLength + "\0" + content)`. It is computable
  locally and identical to what GitHub's tree API returns, so a local build and the
  GitHub-driven sync agree on "same file".
- `syncBranch` already stores `<blobSha> <path>` for every file and diffs
  additions / modifications / renames / deletions. Modifications are currently
  ignored; they become the re-index trigger.
- Astra vectorize pins one embedding model per collection
  (`nvidia/nv-embedqa-e5-v5`, 1024-d, 512-token input cap). `VECTORIZE_MAX_CHARS`
  (750) is the repo's conservative character bound. **Chunk size is dictated by the
  embedding model; there is no overlap.**
- A document can hold up to 4M characters. Only *indexed* strings are limited (8,000
  bytes), so large text fields must be on the indexing deny list.
- Hybrid search (`findAndRerank` with `$hybrid`) needs vector, lexical and rerank
  enabled **at collection creation**; they are immutable. Documents carry both
  `$vector`/`$vectorize` and `$lexical`. Verified against `astra-db-ts` 2.3.0.
- `$in` on `_id` accepts at most 100 values.
- The reranker runs in the US.
- Repo scale: 169 tracked files, ~123 source files, ~1.4 MB of text (277 KB of it
  `package-lock.json`). Scale and cost are not constraints.

### Phase 0 spike results (2026-10-20, issue #38)

Run against a scratch collection created with the exact definition proposed in §4.2
(nvidia vector, `lexical: standard`, nvidia rerank, `text` denied). Scratch
collections were dropped afterwards. The collection held only ~10 toy documents,
so these results show **what the API accepts and how it tokenizes**, not how well
it ranks real code.

| Question | Result | Consequence |
|---|---|---|
| `$lexical` size limit? | **No 8 KB limit.** 2 KB, 8 KB, 9 KB, 20 KB and 100 KB were all accepted. | `$lexical` can be generous, but keep it purposeful. |
| 100 KB deny-listed `text`? | **Accepted** (112,000 chars written and read back intact). | Whole-file storage works; the 86 KB file fits. |
| Tokenization of code | Case-insensitive. **camelCase and `snake_case` are NOT split**: `buildSystemPrompt` and `fetch_file_contents` match only as whole tokens; `build`, `fetch`, `file tree` and `TREE` did not match documents containing `getFileTree` / `TREE_TTL_MS` / `fetch_file_contents`. Dots and slashes do split (`llm.ts`, `lib` matched). | **The extractor must add the split words next to each identifier** (`getFileTree` → `get file tree`; `fetch_file_contents` → `fetch file contents`) so natural-language terms match. |
| Collection-count limit | Creating hybrid collections succeeded up to **10 total** and the 11th failed with `INVALID_DATABASE_QUERY` (message truncated; the cause is inferred to be the index budget, not confirmed). | 3 exist today; the index is the 4th. Roughly 6 more hybrid collections fit. Not a constraint. |
| Array filter + `findAndRerank` | **Works.** `{ branches: "main" }` and `{ branches: "feat-x" }` each returned only matching documents. | Branch-ready schema is viable. |
| `$addToSet` on the array | **Works**, and is idempotent (adding twice leaves one entry). | Add-a-branch needs no read. |
| **`$pull`** | **Not supported**: `UNSUPPORTED_UPDATE_OPERATION: Unrecognized update operator '$pull'`. | **Removing a branch is read-modify-write**: read the document, `$set` the whole array minus the branch. Safe because the sync lease allows one writer. (`$pop` was not tested.) |
| Empty-array cleanup query | `{ branches: { $size: 0 } }` finds documents with no branches. | Garbage collection of orphaned versions works. |
| `findAndRerank` latency | **~520–630 ms** per call (5 warm runs) on a tiny collection; an `_id $in` read of 3 documents took **75 ms**. | The rerank hop is the largest cost of the new path. Whether it beats today's LLM file-selection call is exactly what the Phase 1 baseline must show. |
| Lexical leg on a long question | For the question "how does the github tree cache work" all three results had `$bm25Rank: null`, i.e. the lexical leg contributed nothing and ranking came from the vector leg. One observation; the mechanism (all terms required, stop words) is not confirmed. | Passing the whole question to both legs may waste the lexical leg. Test a separate, keyword-only `$lexical` query in Phase 2/3. |

## 4. Design

### 4.1 Why one document per file

A file is the unit a developer reasons about, the unit the blob SHA identifies, and
the unit citations point into. One document per file means:

- no chunker, no reassembly, no chunk-boundary bugs;
- freshness is a single comparison (`doc.blobSha` vs head tree);
- reading a hit returns the whole file (up to the 4M-char document limit).

The cost is that the vector represents a *summary* of the file rather than its raw
text, because raw files exceed the embedding cap. Lexical search covers exact
identifiers; the summary covers meaning. That is why hybrid search is the core.

### 4.2 Collection `wiki_files`

Created with **vector (vectorize), lexical and rerank** enabled. Indexing **denies**
`text`.

| Field | Notes |
|---|---|
| `_id` | `${path}@${blobSha}` — one document per unique file *version*, shared by every branch that contains it. Deterministic, so re-indexing is idempotent (§4.7). |
| `path` | file location; also searchable via `$lexical` |
| `blobSha` | git blob SHA of the version indexed; the freshness key |
| `branches` | array of branch names whose head contains this exact version, e.g. `["main"]`. Searches filter on it. |
| `size`, `lineCount` | for budgeting prompt size |
| `text` | whole file, exact bytes as UTF-8; **indexing denied** |
| `$vectorize` | LLM-written summary of the file, **≤ 750 chars** — fully embedded, nothing truncated |
| `$lexical` | path + identifiers **with their split words** (`getFileTree get file tree`) + imports + summary. No size limit found up to 100 KB, but it is still scored by BM25, so keep it focused. |
| `summaryVersion` | bump when the summary prompt changes → forces re-summarize |
| `indexedAt`, `commitSha` | diagnostics + the status pill |

### 4.3 Summary and lexical generation

- One LLM call per changed file produces: a ≤ 750-char summary of purpose and role,
  plus a short list of key identifiers. Prompt is versioned (`summaryVersion`).
- Identifiers and imports can also be extracted without an LLM (regex per
  language) and merged into `$lexical`. Cheaper and deterministic; the LLM only
  writes the prose summary. **Each identifier is emitted twice:** as written and
  split into words (camelCase, `snake_case`, `SCREAMING_CASE`), because the
  analyzer does not split them (§3).
- Files too small to be worth summarising (a few lines of config) embed their path
  plus content directly.
- Files that cannot be summarised well (lockfiles, generated output) are out of
  scope (§10 Q on file types).

### 4.4 Retrieval (replaces the file-selector LLM call)

Run in parallel, not in series:

1. `getBranchHead` as a **conditional request** (`If-None-Match` with the stored
   ETag). A `304` is cheap and does not count against the rate limit.
2. `findAndRerank` with `$hybrid: { $vector, $lexical }`, filtered to
   `{ branches: "main" }` (§4.7) → top K file docs (K ≈ 8); `projection` omits
   `text` so ranking is cheap.
3. Read the winning docs' `text` with `_id $in` (≤ 100).
4. **Freshness check:** compare each doc's `blobSha` to the head tree entry for its
   path (from the cached tree). A mismatch ⇒ read that file live from GitHub, and
   mark the answer as "partially live".
5. Build the existing numbered-line prompt (`N| line`) from whole files within the
   prompt budget; stream the answer.
6. **Fallback:** empty or low-confidence results ⇒ today's LLM file-selection path.

### 4.5 Build (initial)

A script alongside `seed-wiki-topics.ts`, run from a local clone:

- `git fetch origin`, then read from the commit `origin/main` points at — **never the
  working tree** (uncommitted edits and `autocrlf` would break blob SHAs and
  permalinks).
- `git ls-tree -r <commit>` → `(path, blobSha)`; `git cat-file --batch` → content.
- Apply the same `isIgnoredPath` / binary filters as the live sync.
- Resumable: skip paths whose stored `blobSha` already matches.
- No GitHub API calls, no rate limits.

### 4.6 Incremental update

- `syncBranch` already yields the diff. For additions + modifications: look up an
  existing document with the same `blobSha` and reuse its summary (no LLM call —
  covers renames and files identical across branches); otherwise fetch the blob and
  generate a summary. Upsert `${path}@${blobSha}` and add the branch to `branches`
  (`$addToSet`).
- For modifications, deletions and renames: remove the branch from the *old*
  version's `branches`. **`$pull` is not supported**, so this is read-modify-write:
  read the document, `$set` the array without the branch. That is safe because the
  sync lease means one writer at a time. A document whose `branches` is empty
  (`{ branches: { $size: 0 } }`) is garbage and gets deleted.
- **Write order:** add the branch to new versions → advance the snapshot → pull the
  branch from old versions → delete empty documents. A reader never sees a path
  with no document; at worst a path briefly has both versions and the freshness
  check (§4.4 step 4) picks the one matching the head tree.
- Large diffs: batch, honour existing rate-limit backoff; if the diff is huge,
  leave it for the next run rather than doing it inside a request.
- **Trigger (decided):** a user-initiated **Sync now** control in the wiki UI, next
  to the branch dropdown and status pill at the top right. The existing 45 s page
  poll stays as well, so sync is automatic *and* directly controllable. The button
  gives a deterministic way to test file updates: change a file, click, watch the
  pill and the document change. A GitHub Action on `push` is a possible later
  addition; it is not part of v1.
- Both triggers call the same `/api/wiki/sync` path and share its lease, so a click
  during a poll tick is a no-op (`locked`), not a double run.

### 4.7 Branches

**v1 indexes `main` only, but the schema is branch-ready.** Documents are per file
*version*, not per branch, and carry a `branches` array. Every search filters on
`branches` (v1: always `"main"`).

- **Adding a branch later needs no migration.** Diff the branch snapshot against
  existing documents: versions already indexed just gain the branch name
  (`$addToSet`, no LLM call); only genuinely new file versions are summarised. A
  feature branch that changes 3 files costs 3 summaries.
- **Removing a branch** is read-modify-write of the `branches` array (no `$pull`),
  plus deleting documents left with no branches.
- **Until a branch is indexed**, the v1 fallback applies: query `main`'s index and
  treat every file whose blob SHA differs on that branch as stale ⇒ live read
  (§4.4 step 4). Degrades gracefully, no extra storage.
- Freshness is unchanged: compare the retrieved document's `blobSha` with the
  *selected* branch's head tree.
- Cost of being branch-ready now: one extra filter on every query, and
  read-modify-write plus empty-document cleanup in the sync. That is the price of avoiding a re-key
  migration later (changing `_id` is not possible in place).

## 5. Speed plan

| Today | After |
|---|---|
| Uncached branch-head call (no ETag) | Conditional request, in parallel with search |
| Tree fetch (60 s cache; expires mid-conversation) | 30 min cache keyed by commit SHA *(done)* |
| Non-streaming file-selection LLM call | `findAndRerank` (one round trip) |
| Up to 15 raw GitHub fetches, 8,000-char cap | One Astra `$in` read, whole files |
| Cold start loses all in-memory caches | Index lives in Astra; caches are only an optimisation |

**Cheap wins that do not need the index** (can ship first, independently):
1. Send `If-None-Match` on the branch-head call.
2. Cache file-selection results per (question, commit).
3. Longer GitHub cache TTLs *(done in `1893859`)*.

## 6. Phases

0. **Spike — DONE (2026-10-20, #38):** results in §3. Outcome: the design stands;
   `$pull` is replaced by read-modify-write and the extractor must emit split
   words. Open for Phase 2/3: a keyword-only `$lexical` query, and whether the
   ~0.5 s rerank hop pays for itself against the baseline.
1. **Baseline:** per-step timing logs in `chat/route.ts` and a fixed question set
   (~15 questions: "where is X", "how does X work", architecture, follow-ups).
   Record time to first token and total time, plus which files were chosen.
   *This is the yardstick for everything after.*
2. **Cheap wins** (§5), re-measure.
3. **Collection + builder script;** index `main`; verify document count and a
   sampled `blobSha` match against GitHub.
4. **Retrieval behind a flag** (`WIKI_INDEX=1`) with fallback to the current path.
5. **Incremental sync** in `syncBranch` + stale-file live reads.
6. **Trigger** (cron / Action) and an index-freshness pill (indexed commit vs head).
7. **Dogfood and evaluate:** the flag stays opt-in. After the initial index, the
   user runs it by hand for a while and compares against the Phase 1 baseline.
   Making it the default is a later, separate decision (§10 Q7).

## Baseline

**Date:** 2026-10-20
**Branch:** `feat/39-baseline-cheap-wins`
**Commit anchor:** `bed0d21` (xavier loop: iteration 2 — wiki phase 1 per-step timing log)
**Server:** `npx next dev -p 3039` (worktree `packages/api`)
**Warm-up:** 1 request discarded before timing run.
**Questions run:** 15 (all from `scripts/wiki-questions.ts`). No failures.

### Notes on tree timing

`treeMs` is 0 ms for all 15 questions. The first call fetches the tree live from
GitHub and caches it in-process (30 min TTL keyed by commit SHA). After the warm-up
request the cache was already warm, so every bench run hit the in-process cache
and the tree fetch cost is absorbed into the server process startup, not the
per-question timing. This will look different on a cold server or after cache
expiry (30 min); Phase 1 records the warm-cache steady-state.

### Per-question results

| Question ID | Category | Files (n) | Files chosen | branchHead ms | tree ms | selection ms | fileFetch ms | TTFT ms | Total ms |
|---|---|---|---|---|---|---|---|---|---|
| `where-llm-client` | where-is-x | 10 | llm.ts, pipeline.ts, enrich.ts, docling.ts, wiki/chat/route.ts, useChat.ts, ChatScreen.tsx, mobile/api.ts, whisper.ts, transcribe.ts | 234 | 0 | 6443 | 200 | 15690 | 42070 |
| `where-upload-limits` | where-is-x | 12 | uploadLimits.ts, upload/route.ts, process/route.ts, recover/audio/route.ts, useRecordingUpload.ts, webMic.ts, localBuffer.ts, storage.ts, recoverPolicy.ts, pipeline.ts, whisper.ts, transcribe.ts | 268 | 0 | 48080 | 286 | 55865 | 71058 |
| `where-db-collections` | where-is-x | 7 | collections.ts, constants.ts, seed-schema.ts, seed-schema-v2.ts, types.ts, client.ts, capabilities.ts | 312 | 0 | 8705 | 204 | 13946 | 19172 |
| `where-ws-ticket` | where-is-x | 15 | wsTicket.ts, ws-ticket/route.ts, sidecar/auth.py, store.ts, recoverPolicy.ts, pipeline.ts, whisper.ts, llm.ts, transcribe.ts, enrich.ts, recover.ts, jev.ts, music.ts, docling.ts, whisper.ts | 141 | 0 | 1425 | 158 | 6380 | 8022 |
| `how-finalize-pipeline` | how-does-x-work | 10 | pipeline.ts, finalize/route.ts, process/route.ts, segments/route.ts, transcribe.ts, whisper.ts, recover.ts, storage.ts, recoverPolicy.ts, sidecar/vad.py | 142 | 0 | 45719 | 264 | 60731 | 125505 |
| `how-audio-recovery` | how-does-x-work | 14 | recoverClient.ts, streamClient.ts, useRecordingUpload.ts, localBuffer.ts, webMic.ts, recover.ts, recoverPolicy.ts, recover/route.ts, recover/audio/route.ts, recover/complete/route.ts, upload/route.ts, research_notes (×3) | 278 | 0 | 6596 | 258 | 24367 | 81670 |
| `how-wiki-topics` | how-does-x-work | 15 | wiki/chat/route.ts, wiki/toc/route.ts, wiki/page.tsx, pipeline.ts, llm.ts, enrich.ts, docling.ts, store.ts, recover.ts, transcript.ts, db/text.ts, whisper.ts, jev.ts, transcribe.ts, whisper.ts | 261 | 0 | 42345 | 192 | 64529 | 137279 |
| `how-github-cache` | how-does-x-work | 5 | github.ts, store.ts, storage.ts, pipeline.ts, docling.ts | 262 | 0 | 5362 | 164 | 26671 | 91560 |
| `how-whisper-transcribe` | how-does-x-work | 10 | whisper.ts, transcribe.ts, transcript.ts, pipeline.ts, sidecar/asr.py, sidecar/session.py, test_asr_pool.py, test_vad_segmenter.py, db/types.ts, whisper.ts | 265 | 0 | 9484 | 201 | 20547 | 34681 |
| `arch-walfly-overview` | architecture | 11 | archify/candidate.json, archify/finalize-summary.json, archify/finalize.json, archify/delivery.json, research_notes (×4), streaming-plan.md, walfly-plan.md, README.md | 144 | 0 | 17601 | 311 | 23173 | 37665 |
| `arch-db-packages` | architecture | 15 | db/client.ts, db/constants.ts, db/index.ts, db/types.ts, db/collections.ts, store.ts, storage.ts, llm.ts, pipeline.ts, recover.ts, whisper.ts, transcript.ts, transcribe.ts, jev.ts, docling.ts | 241 | 0 | 6428 | 153 | 39546 | 137185 |
| `arch-mobile-streaming` | architecture | 15 | useRecordingUpload.ts, webMic.ts, pcm.ts, streamClient.ts, mobile/api.ts, localBuffer.ts, upload/route.ts, process/route.ts, storage.ts, pipeline.ts, recover.ts, whisper.ts, research_notes (×2), llm.ts | 272 | 0 | 20993 | 222 | 29745 | 46924 |
| `followup-recovery-failure` | follow-up | 0 | (none — selector returned 0 files) | 337 | 0 | 65389 | 0 | 67928 | 70593 |
| `followup-github-ratelimit` | follow-up | 7 | github.ts, uploadLimits.ts, recover.ts, recoverPolicy.ts, llm.ts, store.ts, wsTicket.ts | 246 | 0 | 1944 | 0 | 11333 | 26224 |
| `followup-wiki-lease` | follow-up | 13 | wiki/chat/route.ts, wiki/toc/route.ts, pipeline.ts, store.ts, llm.ts, docling.ts, db/collections.ts, db/constants.ts, db/client.ts, wsTicket.ts, recover.ts, enrich.ts, transcript.ts | 142 | 0 | 14704 | 1 | 17949 | 18542 |
| **Median** | — | — | — | **261** | **0** | **9484** | **200** | **24367** | **46924** |
| **Mean** | — | — | — | **236** | **0** | **20081** | **174** | **31893** | **63210** |

### Observations

Medians over 15 questions, dev server (`next dev`), warm tree cache:

| Step | Median ms | Notes |
|---|---|---|
| branchHead | 261 | uncached call, no ETag |
| tree | 0 | in-process cache was warm (see above) |
| selection (file-selector LLM) | 9,484 | range 1,425–65,389 |
| fileFetch | 200 | up to 15 GitHub fetches |
| answer time to first token | ~8,800 | TTFT minus the four steps above; derived, not logged |
| **TTFT** | **24,367** | |
| **Total** | **46,924** | |

- **Two costs share the wait before the first token.** The file-selector call (median
  9.5 s) and the answer model's own first-token latency on a large prompt (median
  about 8.8 s, range 2.2–32.7 s) are of similar size. Replacing selection removes
  the first; it does not remove the second. A lighter prompt (fewer or smaller
  files) is what shrinks the second, and the index design sends whole files, so
  this must be watched in Phase 3.
- **Selection is the most variable step.** Range 1.4–65 s; three questions took over
  40 s. The cause was not investigated (provider queueing, a large tree prompt, or
  both are possible).
- **branchHead and fileFetch are small** (261 ms and 200 ms medians). The conditional
  request saves at most the branchHead cost.
- **`followup-recovery-failure` selected 0 files** after a 65 s selection call, so
  the answer had no code context. A correctness failure as well as a latency one.
- **The Astra `findAndRerank` call (~0.5–0.6 s on a tiny collection, §3)** is far
  below the median selection time, but the collection here is toy-sized and the
  answer's first-token latency remains. Do not assume the whole TTFT gap closes.
- Several selections look weak on inspection (for example, `where-ws-ticket` and
  `arch-db-packages` include many unrelated pipeline files). Quality of selection is
  part of the case for the index, but this was judged by eye, not scored.

## 7. Failure modes and handling

| Failure | Handling |
|---|---|
| Index lags head | per-file freshness check ⇒ live read for changed files |
| Interrupted upsert | `blobSha` on the doc is the truth; a half-written doc is simply stale ⇒ live read |
| Force-push / history rewrite | commit not found ⇒ full resync from local clone |
| Summary LLM outage | store doc with path-only `$vectorize`, flag `summaryVersion: 0`, backfill later |
| Vectorize outage | existing `saveTopics` pattern: log, store without vector, backfill |
| Reranker unavailable / slow | fall back to plain `$hybrid` ordering without rerank |
| Truncated GitHub tree | existing guard: skip incremental sync, keep stored state |
| Head ETag `304` but index behind | index commit ≠ head commit ⇒ treat all changed paths as stale |
| Rate limited | existing backoff; serve from index + cached tree, mark "possibly stale" |

### Phase 3 notes (issue #41)

- **Where:** `lib/wiki/index-files/retriever.ts` (`retrieveFiles`), called from
  `buildSystemPrompt` in `app/api/wiki/chat/route.ts` only when `WIKI_INDEX=1`, right after the
  tree is fetched. Flag off: the selector path is untouched. Flag on and `usedIndex`: no selector
  LLM call and no GitHub fetch fan-out (only live reads of stale files). Otherwise the existing
  selector path runs unchanged. Timing log / `timings` SSE gained `source`, `retrievalMs`,
  `liveReads`, `droppedStale`, `rerank`.
- **Search:** `findAndRerank` with `$hybrid: { $vectorize: <full question>, $lexical: <keyword query> }`,
  filtered to `branches: "main"` for every selected branch. The keyword query drops stop words and
  keeps identifiers as written plus their split words (a whole sentence gave `$bm25Rank: null`).
  `text` is included in the projection of the same query (top 8 only), so there is no second `_id $in` read.
- **Freshness:** doc `blobSha` == tree sha -> Astra text; different -> live read at `commitSha`;
  path absent from the tree -> dropped; a stale file whose live read fails -> dropped.
- **Prompt size:** 120,000 chars total, 30,000 per file, rank order. Oversized files are windowed
  around the densest keyword region with real line numbers (`[showing lines a-b of N]`).
- **Low confidence:** `MIN_TOP_RERANK_SCORE = -12.5`. Top `$rerank` over the 15 benchmark questions:
  12.52, 12.52, 8.53, 4.55, 3.98, 3.41, 2.56, 0.71, 0.04, -1.85, -1.85, -4.55, -11.38, -13.66, -18.20.
  Gibberish: -13.66; off-topic (cookies, football): -18.20 each. The scores overlap at the bottom
  (the two weakest real questions look like the junk), so those two fall back to the selector.
  Fallback costs speed, not correctness.
- **Degraded mode:** if the reranked search errors or exceeds 15 s, it is retried as a plain vector
  search over `$vectorize` (`find` + `sort: { $vectorize }`; `findAndRerank` always reranks) and
  marked `rerank: false`, using `MIN_TOP_VECTOR_SCORE = 0.655` (junk top similarity 0.58-0.65;
  real questions' best hits >= 0.662, a thin gap). If that also fails, or results are empty / low
  confidence / all dropped, `usedIndex: false` and the selector path runs.
- **Verification:** `npm run verify:retriever` (offline, injected fakes). Not verified: a stale-file
  live read against a real differing branch (pushed `main` equals the index).

## 8. Testing

- Unit: blob-SHA helper (matches `git hash-object`), identifier/import extraction,
  freshness comparison, `$lexical` size bound.
- Integration: fixture repo → build → mutate one file → incremental sync → exactly
  one document changes.
- Eval: the Phase 1 question set; compare chosen files and answer quality against
  the current selector, and latency against the baseline.

## 9. Risks

- **Summary-only vectors.** An "architecture" question may rank poorly if summaries
  are vague. Mitigation: hybrid + rerank, fallback to the LLM selector, and if
  needed a later extension to per-section documents (same collection, `_id` =
  `path#section`) — only if the eval shows file-level is too crude.
- **Summary drift.** An LLM summary can be wrong. Retrieval only *finds* the file;
  the answer is always generated from the real text, so a wrong summary degrades
  recall, not correctness.
- **Prompt size.** Whole files can blow the context budget. Cap total prompt
  characters and prefer top-ranked files; the 86 KB file needs a per-file cap or
  windowing around the best match.
- **Reranker data residency.** Reranking runs in the US. Fine for this repo; revisit
  if private code is ever indexed.
- **Two writers** (local script + deployed sync) must agree. Mitigation: one shared
  `indexFile()` function and idempotent `_id`s.
- **Collection budget.** Verified: the database accepted 10 hybrid collections; we use 3 and this adds a 4th.
- **Rerank latency.** About 0.5–0.6 s per `findAndRerank` call in the spike. If the
  Phase 1 baseline shows the file-selection LLM call is faster than that, the
  speed case rests on removing the GitHub fetch fan-out and the 8,000-char cap,
  not on the search itself. Consider hybrid without rerank as a measured option.

## 10. Open questions

_Resolved one at a time; answers get folded into the sections above._

1. ~~Where does the incremental sync run?~~ — resolved: user-initiated button in
   the header, plus the existing 45 s poll (§4.6).
2. ~~Chunk size~~ — resolved: not chunking; summary ≤ 750 chars.
3. ~~Single branch?~~ — resolved: `main` only for v1; other branches query `main`'s
   index and read differing files live (§4.7).
4. ~~Rerank?~~ — resolved: on by default, and enabled on the collection at creation
   (immutable afterwards, §3). Falls back to plain `$hybrid` order if the reranker
   is unavailable (§7).
5. ~~Scoped retrieval for topic pages?~~ — resolved: whole-repo search always. A
   path-prefix filter can be added later without rebuilding the index, since `path`
   is already stored.
6. ~~File types in scope?~~ — resolved: code, docs and config are indexed; lockfiles,
   generated output and binaries are skipped. Use the same `isIgnoredPath` filter as
   the live sync so the two never disagree (verify in Phase 3 that it excludes
   `package-lock.json`).
7. ~~Success criteria for flipping the flag?~~ — resolved: no default flip planned
   yet. After the initial index is built, the flag stays opt-in while the user
   dogfoods it; the criteria (speed vs. baseline, file-choice quality, freshness
   after Sync now) are set at that point, informed by the Phase 1 baseline.
8. ~~Anything that must never be indexed?~~ — resolved: an explicit deny list on top
   of `isIgnoredPath`: `.env*` (except `.env.example`), `.beads/`, `.bob/`,
   `.worktrees/`. Checked: `.env.local` is git-ignored and no files under
   `.beads/`, `.bob/` or `.worktrees/` are tracked, so a build from `origin/main`
   cannot reach them today. The deny list is defence in depth (e.g. if someone
   later commits one), and applies to both the builder and the sync. Add a unit
   test that the deny list rejects those paths.
9. ~~`_id` shape?~~ — resolved: `${path}@${blobSha}` plus a `branches` array, so
   branches can be added later without a migration (§4.2, §4.7). `main` only in v1.

### Phase 4 notes (issue #42)

**Design as built.** `lib/wiki/index-files/index-sync.ts` exposes `addIndexVersions`
(phase A), `pruneIndexVersions` (phase B) and `combineIndexSyncResults`. `syncBranch`
(`lib/wiki/sync.ts`) calls them via never-throwing wrappers; any failure becomes
`index.status: 'failed'` in the outcome and never fails the topic sync. The outcome
(and `POST /api/wiki/sync` JSON) carries `index` (`status`, counts, `warning`,
`indexedHeadSha`). `WikiSnapshotDoc.indexedHeadSha` is the new field.

**Write order (inside the existing lease try/finally, §4.6):**
1. add: for each indexable path in the new tree, ensure a `path@blobSha` doc lists `main`
   (existing current doc: `$addToSet`; same blob elsewhere: reuse summary, 0 LLM calls;
   else fetch bytes at the commit, verify the git blob SHA, `indexFile`);
2. `saveTopics` / `deleteTopicsByIds` / `saveSnapshot` (unchanged behaviour);
3. prune: `main` is removed from docs whose path is gone from the tree, or whose path
   changed AND the replacement is confirmed; docs left with `branches: []` are deleted
   (`deleteMany({_id:{$in}, branches:{$size:0}})`, per-id fallback). Docs also listing
   another branch keep that branch. If the add phase `failed`, prune is skipped entirely
   (its target map may be incomplete);
4. only when add+prune were fully clean: `saveSnapshot({... indexedHeadSha: head.sha})`.
An interruption at any point leaves extra, never missing, documents.

**Deferral.** If more than `WIKI_INDEX_SYNC_MAX_FILES` (default 40) files need real work,
the add phase writes only cheap branch-adds, summarises nothing, returns `deferred` with
a warning pointing at `npm run build-wiki-index`; prune never pulls an old version whose
replacement is unconfirmed, so no path is lost. `indexedHeadSha` is not advanced.

**Catch-up.** `reconcileIndexForSnapshot` runs on the 304 / same-sha / identical-tree
paths when `indexedHeadSha !== headSha`: it takes the lease (skips if held), re-reads
the snapshot, decodes `fileListText` (no sizes; `indexFile` enforces size) and runs
add -> prune -> `indexedHeadSha`. Failed/deferred catch-ups are throttled to one attempt
per 5 min per process so polls stay cheap. Fully caught up (`indexedHeadSha === headSha`)
costs nothing.

**Gating.** Everything is a no-op (zero Astra/GitHub calls, `index.status` 'disabled',
`index` omitted from the outcome) unless `WIKI_INDEX=1` and `branch === 'main'`.

**Deviations.** Non-main branches are not indexed in v1 (disabled, not merely
deferred). Concurrency is guaranteed by inspection (all index work is inside the
existing `acquireLease`/`releaseLease`), not by an automated lease test.

**Offline verification:** `npm run verify:index-sync` (in-memory fake collection, fake
summariser/fetcher; covers modify, rename, delete, interruption, deferral, failure
isolation, SHA mismatch, shared-branch preservation, idempotency, flag/branch gating).

**Live test recipe (after merge, needs `WIKI_INDEX=1`):**
1. On a fresh clone run `npm run build-wiki-index` first, so a
   baseline exists (the first sync after that backfills `indexedHeadSha`).
2. Edit and push a file on `main`.
3. `POST /api/wiki/sync` (or click Sync now); expect `status: 'synced'` and
   `index: { status: 'ok', added: 1, pruned: 1, deleted: 1, indexedHeadSha: <head> }`.
4. In `wiki_files` check `path@<newBlobSha>` exists with `branches: ['main']` and the
   old `path@<oldBlobSha>` is gone. Repeat the POST: `unmodified`, no `index` (caught up).

## Phase 6 — Dogfood and evaluation (issue #44)

**Date:** 2026-10-21. **Setup:** `WIKI_INDEX=1 npx next dev -p 3039`, live `wiki_files` (129 docs, `main` @ `792e480`), same 15 questions and runner as the baseline (`npm run bench:wiki-chat`), one warm-up request discarded. Raw output: `/tmp/bench-index-final.log` (not committed). **No default was changed.**

### Baseline vs index (15 questions, medians unless stated)

| Metric | Baseline (live selector) | `WIKI_INDEX=1` | Change |
|---|---|---|---|
| Selection step | 9,484 ms (range 1.4–65 s) | 0 ms for 13 of 15; selector still ran for 2 fallbacks (1.3 s, 4.9 s) | removed on the index path |
| Index retrieval (spot checks, not in the bench output) | n/a | 0.8–1.9 s with rerank; **~15.7 s when rerank times out** (see weak spots) | new cost |
| File fetch | 200 ms | 0 ms (text comes from the index) | -200 ms |
| Time to first token | 24,367 ms (mean 31,893) | 13,069 ms (mean 15,949) | **-46% median, -50% mean** |
| Total | 46,924 ms (mean 63,210) | 42,235 ms (mean 62,995) | -10% median, ~flat mean |
| Files per answer | 0–15, varied | 8 (13 questions), 13 and 15 (fallbacks) | fixed top-8 |
| Questions with 0 files | 1 (`followup-recovery-failure`) | 0 | fixed |

Total time barely moves because it is dominated by the answer model's generation, which the index does not change. TTFT is where it helps. One outlier inflates the index mean total: `followup-recovery-failure` took 346 s total (TTFT 35.8 s); that is a streaming stall, not retrieval, and was not investigated. `followup-wiki-lease` total 8.4 s is a short answer, not a speed-up to claim.

Fallbacks to the old selector: `how-wiki-topics` (top rerank -13.66 < -12.5) and `followup-wiki-lease` (-18.20). Both produced a normal answer through the old path, as designed.

### Freshness scenarios exercised

Live Astra index (built from `origin/main`), questions asked against other branches:

| Scenario | Result |
|---|---|
| `main` (index current) | `source=index`, 0 live reads, 0 dropped |
| `feat/36-live-codebase-wiki` (55 files differ from `main`) | `source=index`, **2 files read live from GitHub, 1 dropped as stale**; answer cited that branch's commit `903b153` |
| `feat/streaming-sidecar` | `source=index`, 4 stale files dropped, 0 live reads; commit `2f9326c` |

Not exercised live (deliberately; they would write to the live `wiki_toc`/`wiki_files`): modify, rename and delete via real sync, concurrent syncs, interrupted sync. Those are covered offline by `verify:index-sync` and must be run live after merge (recipe in the Phase 4 notes). Correction to that recipe: a caught-up repeat POST now returns `unmodified` **with** `index: { status: 'ok', indexedHeadSha }` read from the snapshot (added in Phase 5 so the pill can show indexed vs head), not with no `index`.

### Weak spots

1. **Reranker latency.** 5 of the ~22 requests made during this run hit the 15 s `SEARCH_TIMEOUT_MS`, fell back to vector-only and cost ~15.7 s of retrieval; the last three spot checks in a row did. When rerank works it is 0.8–1.9 s. Recommendation: lower the timeout to about 4–5 s so a slow reranker costs less than the selector it replaces, and investigate whether the rerank service rate-limits under the bench's back-to-back load.
2. **`$bm25Rank` is null on every query** (Phase 3 finding): the lexical leg is not demonstrably contributing; retrieval is effectively vector + rerank. Worth a separate check before claiming "hybrid".
3. **Confidence threshold** sends the two weakest real questions to the old selector. Fine as a safety net, but 2 of 15 means the fast path covers about 87% of this question set.
4. **Fixed top-8 files.** Broad architecture questions got 8 files, some of them noise (`SETUP.md`, `.env.example`, `research_notes` are indexed). Quality was judged by eye, not scored.
5. **Total time is unchanged** because answer generation dominates; the visible win is first-token latency.
6. **Index covers `main` only.** Other branches rely on live reads for every differing file; on a branch with many changes the saving shrinks.

### Recommendation

Keep it **opt-in** (`WIKI_INDEX=1`). Do not make it the default yet. Order of work before reconsidering: (1) fix the rerank timeout/latency, (2) run the live sync scenarios after merge, (3) re-run this benchmark and score answer quality on a sample rather than by eye. If rerank latency is fixed and quality holds, make it the default with the flag as an off switch. Per-section documents are not needed for the observed failures.

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

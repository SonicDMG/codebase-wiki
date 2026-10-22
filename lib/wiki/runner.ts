/**
 * runner.ts — background job runner for the wiki.
 *
 * Routes depend on the `JobRunner` interface via `getJobRunner()`; the only
 * implementation is `LocalDetachedRunner`, a fire-and-forget async function
 * started by `start()` and NOT awaited by the HTTP request.
 *
 * Job state lives on the branch snapshot document (see store.ts). The job
 * "lease" is the job's own ownership/heartbeat fields (`job.id`, `job.status`,
 * `job.heartbeatAt`); it is separate from the 2-minute sync lease in store.ts.
 *
 * "One running job per branch" is ADVISORY: Astra has no compare-and-swap, so
 * the check is (in-process Map guard) + (DB read of status/heartbeat). The Map
 * closes the same-process race; the DB check covers other processes. That is
 * acceptable for a local-only runner.
 */

import { randomUUID } from 'node:crypto';
import {
  appendRecentJob,
  acquireLease as acquireSyncLease,
  releaseLease as releaseSyncLease,
  getSnapshot,
  getStoredTopics,
  replaceTopics,
  saveSnapshot,
  requestJobCancel,
  updateJobFields,
  updateSnapshotJob,
  updateTopicFields,
} from './store';
import { decodeFileList } from './snapshot';
import { classifyStaleness, hasPictureCards } from './staleness';
import type { PageMode } from './staleness';
import {
  FETCH_FAILED_PAGE,
  NO_SOURCE_FILES_PAGE,
  buildSnapshotDoc,
  generatePagesForTopic,
  generateTopics,
  pageFieldsToStore,
} from './generate';
import type {
  WikiJob,
  WikiJobFailure,
  WikiJobRequest,
  WikiJobStage,
  WikiJobStatus,
  WikiTopicDoc,
} from './types';

const LOG = '[wiki/job]';

/** A job counts as running only while its heartbeat is this fresh. */
export const JOB_HEARTBEAT_STALE_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const CONCURRENCY = 2;
const MAX_ERROR_CHARS = 500;

// ── Interface ─────────────────────────────────────────────────────────────────

export type StartResult =
  | { status: 'started'; jobId: string }
  | { status: 'nothing-to-do' };

export class JobAlreadyRunningError extends Error {
  constructor(public readonly jobId: string) {
    super(`A job is already running on this branch (job ${jobId}).`);
    this.name = 'JobAlreadyRunningError';
  }
}

export interface JobRunner {
  /** Start a job and return immediately. Throws JobAlreadyRunningError if one runs. */
  start(branch: string, request: WikiJobRequest): Promise<StartResult>;
  /** Ask the running job (if any) to stop after in-flight topics finish. */
  stop(branch: string): Promise<boolean>;
  /** Resume an interrupted job. Not implemented locally until phase 7. */
  resume(branch: string): Promise<{ jobId: string }>;
  /** Write a fresh heartbeat for the job. */
  heartbeat(branch: string, jobId: string): Promise<void>;
  /** Claim the branch's job slot for `jobId`. False if another live job holds it. */
  acquireLease(branch: string, jobId: string): Promise<boolean>;
  /** Release the in-process claim for `jobId`. */
  releaseLease(branch: string, jobId: string): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when the job is 'running' with a heartbeat within the last 30 s. */
export function isJobLive(job: WikiJob | undefined | null, now = Date.now()): boolean {
  if (!job || job.status !== 'running') return false;
  const beat = Date.parse(job.heartbeatAt);
  return Number.isFinite(beat) && now - beat <= JOB_HEARTBEAT_STALE_MS;
}

const errMsg = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);

interface WorkItem {
  topic: WikiTopicDoc;
  modes: PageMode[];
}

interface Plan {
  items: WorkItem[];
  entries: ReturnType<typeof decodeFileList>;
  allPaths: string[];
  commit: string;
}

/** Build the generation plan for a job request. */
async function planFor(branch: string, request: WikiJobRequest): Promise<Plan | null> {
  const [topics, snapshot] = await Promise.all([getStoredTopics(branch), getSnapshot(branch)]);
  if (!snapshot || topics.length === 0) {
    if (request.kind === 'refresh-page') {
      throw new Error(`Unknown topic "${request.slug}"`);
    }
    return null;
  }
  const entries = decodeFileList(snapshot.fileListText);
  const items: WorkItem[] = [];

  if (request.kind === 'refresh-stale') {
    for (const topic of topics) {
      const modes = (['wiki', 'picture'] as PageMode[]).filter(
        (m) => classifyStaleness(topic, m, entries).state !== 'current',
      );
      if (modes.length > 0) items.push({ topic, modes });
    }
  } else if (request.kind === 'refresh-field-guide') {
    for (const topic of topics) {
      if (request.onlyStale) {
        if (classifyStaleness(topic, 'picture', entries).state !== 'current') {
          items.push({ topic, modes: ['picture'] });
        }
      } else {
        items.push({ topic, modes: ['picture'] });
      }
    }
  } else if (request.kind === 'refresh-page') {
    const topic = topics.find((t) => t.slug === request.slug);
    if (!topic) {
      throw new Error(`Unknown topic "${request.slug}"`);
    }
    items.push({ topic, modes: [request.mode] });
  }

  return { items, entries, allPaths: entries.map((e) => e.path), commit: snapshot.headSha };
}

/** Reject empty / placeholder / card-less pages. Returns an error string or null. */
function validatePage(mode: PageMode, page: string | undefined): string | null {
  if (page === undefined || page.trim().length === 0) return `${mode} page was empty`;
  const trimmed = page.trim();
  if (trimmed === NO_SOURCE_FILES_PAGE || trimmed === FETCH_FAILED_PAGE) {
    return `${mode} generation produced a placeholder (${trimmed})`;
  }
  if (mode === 'picture' && !hasPictureCards(page)) return 'picture page has no valid cards';
  return null;
}

// ── Local implementation ──────────────────────────────────────────────────────

class LocalDetachedRunner implements JobRunner {
  /** branch -> jobId for jobs running in THIS process. Survives HMR via globalThis. */
  private get active(): Map<string, string> {
    const g = globalThis as { __wikiActiveJobs?: Map<string, string> };
    return (g.__wikiActiveJobs ??= new Map());
  }

  async acquireLease(branch: string, jobId: string): Promise<boolean> {
    const held = this.active.get(branch);
    if (held && held !== jobId) return false;
    const snap = await getSnapshot(branch);
    if (isJobLive(snap?.job) && snap?.job?.id !== jobId) return false;
    // Re-check after the await: another start() in this process may have won.
    const heldNow = this.active.get(branch);
    if (heldNow && heldNow !== jobId) return false;
    this.active.set(branch, jobId);
    return true;
  }

  async releaseLease(branch: string, jobId: string): Promise<void> {
    if (this.active.get(branch) === jobId) this.active.delete(branch);
  }

  async heartbeat(branch: string, jobId: string): Promise<void> {
    await updateJobFields(branch, jobId, { heartbeatAt: new Date().toISOString() });
  }

  async stop(branch: string): Promise<boolean> {
    const flagged = await requestJobCancel(branch);
    console.log(`${LOG} stop requested for ${branch}: ${flagged ? 'flagged' : 'no running job'}`);
    return flagged;
  }

  async resume(_branch: string): Promise<{ jobId: string }> {
    throw new Error('resume arrives in phase 7');
  }

  async start(branch: string, request: WikiJobRequest): Promise<StartResult> {
    // Fast in-process reject, then DB check (inside acquireLease).
    const held = this.active.get(branch);
    if (held) throw new JobAlreadyRunningError(held);

    const jobId = randomUUID();
    const snapBefore = await getSnapshot(branch);
    if (isJobLive(snapBefore?.job)) throw new JobAlreadyRunningError(snapBefore!.job!.id);
    if (!(await this.acquireLease(branch, jobId))) {
      throw new JobAlreadyRunningError(this.active.get(branch) ?? snapBefore?.job?.id ?? 'unknown');
    }

    try {
      // Rebuild kind: create job immediately (topic count unknown) and run detached.
      if (request.kind === 'rebuild') {
        const now = new Date().toISOString();
        const stages: WikiJobStage[] = [{ kind: 'rebuild' }];
        const job: WikiJob = {
          id: jobId,
          kind: 'rebuild',
          status: 'running',
          stages,
          total: 0,
          finished: 0,
          succeeded: 0,
          failures: [],
          currentSlugs: [],
          startedAt: now,
          heartbeatAt: now,
          cancelRequested: false,
        };
        await updateSnapshotJob(branch, job);
        console.log(`${LOG} ${jobId} rebuild started on ${branch}`);
        void this.runRebuild(branch, job).catch((e) =>
          console.error(`${LOG} ${jobId} rebuild runner crashed unexpectedly:`, e),
        );
        return { status: 'started', jobId };
      }

      // Plan up front so "nothing to do" never creates a running job.
      const plan = await planFor(branch, request);
      if (!plan || plan.items.length === 0) {
        await this.releaseLease(branch, jobId);
        console.log(`${LOG} nothing to do for ${branch}`);
        return { status: 'nothing-to-do' };
      }

      const now = new Date().toISOString();
      const stages: WikiJobStage[] = [{ kind: 'refresh-pages' }];
      const job: WikiJob = {
        id: jobId,
        kind: request.kind,
        status: 'running',
        stages,
        total: plan.items.length,
        finished: 0,
        succeeded: 0,
        failures: [],
        currentSlugs: [],
        startedAt: now,
        heartbeatAt: now,
        cancelRequested: false,
      };
      await updateSnapshotJob(branch, job);
      console.log(`${LOG} ${jobId} started on ${branch}: ${job.total} topic(s)`);

      // Detached: not awaited by the request.
      void this.run(branch, job, plan).catch((e) =>
        console.error(`${LOG} ${jobId} runner crashed unexpectedly:`, e),
      );
      return { status: 'started', jobId };
    } catch (err) {
      await this.releaseLease(branch, jobId);
      throw err;
    }
  }

  /** Whole job body. Never rejects; always writes a final status. */
  private async run(branch: string, job: WikiJob, plan: Plan): Promise<void> {
    const jobId = job.id;
    let status: WikiJobStatus = 'failed';
    let finished = 0;
    let succeeded = 0;
    const failures: WikiJobFailure[] = [];
    const inFlight = new Set<string>();

    const beat = () => {
      void this.heartbeat(branch, jobId).catch((e) =>
        console.warn(`${LOG} ${jobId} heartbeat failed:`, errMsg(e)),
      );
    };
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

    // Progress is written with dotted-path $sets of progress fields only —
    // never the whole `job` object — so a concurrent cancel flag survives.
    const writeProgress = async () => {
      try {
        await updateJobFields(branch, jobId, {
          finished,
          succeeded,
          failures: [...failures],
          currentSlugs: [...inFlight],
          heartbeatAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`${LOG} ${jobId} progress write failed:`, errMsg(e));
      }
    };

    try {
      for (const stage of job.stages) {
        if (stage.kind === 'refresh-pages') {
          const cancelled = await this.refreshPages(branch, jobId, plan, {
            inFlight,
            writeProgress,
            onResult: (ok, failure) => {
              finished++;
              if (ok) succeeded++;
              else if (failure) failures.push(failure);
            },
          });
          if (cancelled) {
            status = 'cancelled';
            break;
          }
        }
        // rebuild stage is handled entirely in runRebuild; should never reach here
      }
      if (status !== 'cancelled') {
        status = failures.length > 0 ? 'completed-with-errors' : 'completed';
      }
    } catch (e) {
      status = 'failed';
      console.error(`${LOG} ${jobId} failed:`, e);
      failures.push({ slug: '*', modes: [], error: errMsg(e) });
    } finally {
      clearInterval(timer);
      inFlight.clear();
      const finishedAt = new Date().toISOString();
      try {
        await updateJobFields(branch, jobId, {
          status,
          finished,
          succeeded,
          failures,
          currentSlugs: [],
          finishedAt,
          heartbeatAt: finishedAt,
        });
        await appendRecentJob(branch, {
          id: jobId,
          kind: job.kind,
          status,
          total: job.total,
          finished,
          succeeded,
          failed: failures.length,
          startedAt: job.startedAt,
          finishedAt,
        });
      } catch (e) {
        console.error(`${LOG} ${jobId} could not write final status:`, e);
      }
      await this.releaseLease(branch, jobId);
      console.log(
        `${LOG} ${jobId} ${status}: ${succeeded}/${job.total} succeeded, ${failures.length} failure(s)`,
      );
    }
  }

  /** Stage: regenerate stale pages, concurrency 2. Returns true if cancelled. */
  private async refreshPages(
    branch: string,
    jobId: string,
    plan: Plan,
    ctx: {
      inFlight: Set<string>;
      writeProgress: () => Promise<void>;
      onResult: (ok: boolean, failure?: WikiJobFailure) => void;
    },
  ): Promise<boolean> {
    const queue = [...plan.items];
    let cancelled = false;

    const worker = async () => {
      for (;;) {
        if (cancelled) return;
        // Re-read the cancel flag from the DB BEFORE starting each topic.
        const snap = await getSnapshot(branch);
        if (snap?.job?.id === jobId && snap.job.cancelRequested) {
          cancelled = true;
          console.log(`${LOG} ${jobId} cancel requested; not starting new topics`);
          return;
        }
        const item = queue.shift();
        if (!item) return;
        const slug = item.topic.slug;
        ctx.inFlight.add(slug);
        await ctx.writeProgress();
        const failure = await this.refreshTopic(branch, plan, item);
        ctx.inFlight.delete(slug);
        ctx.onResult(!failure, failure ?? undefined);
        await ctx.writeProgress();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return cancelled;
  }

  /** Generate, validate and save one topic. Returns a failure record or null. */
  private async refreshTopic(
    branch: string,
    plan: Plan,
    { topic, modes }: WorkItem,
  ): Promise<WikiJobFailure | null> {
    try {
      const pages = await generatePagesForTopic(
        topic,
        branch,
        plan.commit,
        plan.allPaths,
        modes,
        plan.entries,
      );
      for (const mode of modes) {
        const problem = validatePage(mode, pages[mode]);
        if (problem) {
          console.warn(`${LOG} topic "${topic.slug}" failed: ${problem}`);
          return { slug: topic.slug, modes, error: problem };
        }
      }
      await updateTopicFields(topic._id, pageFieldsToStore(pages, plan.commit));
      return null;
    } catch (e) {
      console.warn(`${LOG} topic "${topic.slug}" failed:`, errMsg(e));
      return { slug: topic.slug, modes, error: errMsg(e) };
    }
  }
  /** Full rebuild: generateTopics -> generate all pages in memory -> swap. Never rejects. */
  private async runRebuild(branch: string, job: WikiJob): Promise<void> {
    const jobId = job.id;
    let status: WikiJobStatus = 'failed';
    let finished = 0;
    let succeeded = 0;
    const failures: WikiJobFailure[] = [];
    const inFlight = new Set<string>();

    const beat = () => {
      void this.heartbeat(branch, jobId).catch((e) =>
        console.warn(`${LOG} ${jobId} heartbeat failed:`, errMsg(e)),
      );
    };
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

    const writeProgress = async () => {
      try {
        await updateJobFields(branch, jobId, {
          finished,
          succeeded,
          failures: [...failures],
          currentSlugs: [...inFlight],
          heartbeatAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`${LOG} ${jobId} progress write failed:`, errMsg(e));
      }
    };

    // Staged in memory; nothing goes to the DB until the swap.
    const stagedTopics: WikiTopicDoc[] = [];
    let cancelled = false;

    try {
      // (a) Generate topic list.
      console.log(`${LOG} ${jobId} rebuild: generating topics for ${branch}`);
      const { result, snapshotEntries, unclassifiedPaths, treeSha } = await generateTopics(branch);
      const newTopics = result.topics;
      const headSha = result.headSha;
      const allPaths = snapshotEntries.map((e) => e.path);

      if (newTopics.length === 0) {
        status = 'failed';
        failures.push({ slug: '*', modes: [], error: 'generateTopics returned zero topics' });
        return; // falls into finally
      }

      // Update job total now that we know it.
      await updateJobFields(branch, jobId, { total: newTopics.length, heartbeatAt: new Date().toISOString() });
      job.total = newTopics.length;

      // (b) Generate pages for every new topic in memory, concurrency 2.
      const queue = newTopics.map((topic) => ({ topic, modes: ['wiki', 'picture'] as PageMode[] }));

      const worker = async () => {
        for (;;) {
          if (cancelled) return;
          // Re-read cancel flag from DB before each topic (matches refreshPages behaviour).
          const snap = await getSnapshot(branch);
          if (snap?.job?.id === jobId && snap.job.cancelRequested) {
            cancelled = true;
            console.log(`${LOG} ${jobId} rebuild cancel requested`);
            return;
          }
          const item = queue.shift();
          if (!item) return;
          const { topic, modes } = item;
          const slug = topic.slug;
          inFlight.add(slug);
          await writeProgress();

          // Generate pages.
          let topicWithPages = topic;
          try {
            const pages = await generatePagesForTopic(
              topic,
              branch,
              headSha,
              allPaths,
              modes,
              snapshotEntries,
            );
            const failedModes: PageMode[] = [];
            for (const mode of modes) {
              const problem = validatePage(mode, pages[mode]);
              if (problem) {
                console.warn(`${LOG} ${jobId} rebuild topic "${slug}" ${mode}: ${problem}`);
                failedModes.push(mode);
              }
            }
            if (failedModes.length > 0) {
              failures.push({ slug, modes: failedModes, error: `validation failed for modes: ${failedModes.join(', ')}` });
            }
            // Store pages for modes that passed; failed modes use placeholder from generate.
            const goodPages = { ...pages };
            for (const m of failedModes) {
              delete (goodPages as Record<string, unknown>)[m];
            }
            topicWithPages = { ...topic, ...pageFieldsToStore(goodPages, headSha) };
          } catch (e) {
            console.warn(`${LOG} ${jobId} rebuild topic "${slug}" failed:`, errMsg(e));
            failures.push({ slug, modes, error: errMsg(e) });
            // topic without pages stays staged (old wiki untouched until swap)
          }

          stagedTopics.push(topicWithPages);
          inFlight.delete(slug);
          finished++;
          if (!failures.find((f) => f.slug === slug)) succeeded++;
          await writeProgress();
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, newTopics.length) }, worker));

      // (c) Check if cancelled / zero topics staged.
      if (cancelled) {
        status = 'cancelled';
        console.log(`${LOG} ${jobId} rebuild cancelled before swap; old wiki untouched`);
        return; // finally will write status
      }

      if (stagedTopics.length === 0) {
        status = 'failed';
        failures.push({ slug: '*', modes: [], error: 'no topics staged after generation' });
        return;
      }

      // (d) Swap: acquire sync lease (up to 3 retries, 5 s apart).
      let leaseAcquired = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await acquireSyncLease(branch)) {
          leaseAcquired = true;
          break;
        }
        if (attempt < 2) {
          console.warn(`${LOG} ${jobId} sync lease locked; retrying in 5 s (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }

      if (!leaseAcquired) {
        status = 'failed';
        failures.push({ slug: '*', modes: [], error: 'could not acquire sync lease after 3 attempts; old wiki untouched' });
        return;
      }

      try {
        console.log(`${LOG} ${jobId} rebuild swapping ${stagedTopics.length} topics`);
        await replaceTopics(branch, stagedTopics);
        const snapshotDoc = buildSnapshotDoc(branch, snapshotEntries, unclassifiedPaths, headSha, treeSha);
        await saveSnapshot({ ...snapshotDoc, leaseUntil: null });
        console.log(`${LOG} ${jobId} rebuild swap complete`);
      } finally {
        await releaseSyncLease(branch).catch((e) =>
          console.warn(`${LOG} ${jobId} sync lease release failed:`, errMsg(e)),
        );
      }

      status = failures.length > 0 ? 'completed-with-errors' : 'completed';
    } catch (e) {
      status = 'failed';
      console.error(`${LOG} ${jobId} rebuild failed:`, e);
      failures.push({ slug: '*', modes: [], error: errMsg(e) });
    } finally {
      clearInterval(timer);
      inFlight.clear();
      const finishedAt = new Date().toISOString();
      try {
        await updateJobFields(branch, jobId, {
          status,
          finished,
          succeeded,
          failures,
          currentSlugs: [],
          finishedAt,
          heartbeatAt: finishedAt,
        });
        await appendRecentJob(branch, {
          id: jobId,
          kind: job.kind,
          status,
          total: job.total,
          finished,
          succeeded,
          failed: failures.length,
          startedAt: job.startedAt,
          finishedAt,
        });
      } catch (e) {
        console.error(`${LOG} ${jobId} could not write final status:`, e);
      }
      await this.releaseLease(branch, jobId);
      console.log(
        `${LOG} ${jobId} rebuild ${status}: ${succeeded}/${job.total} succeeded, ${failures.length} failure(s)`,
      );
    }
  }
}

// ── Singleton accessor ────────────────────────────────────────────────────────

// Module-level (not globalThis) so dev HMR picks up edits; the only shared
// state, the active-jobs map, already lives on globalThis.
const runner: JobRunner = new LocalDetachedRunner();

export function getJobRunner(): JobRunner {
  return runner;
}

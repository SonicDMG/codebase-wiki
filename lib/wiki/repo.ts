/**
 * repo.ts — resolve which GitHub repo a request is about.
 *
 * Every route takes an optional `repo` ("owner/name"). When absent it falls
 * back to WIKI_DEFAULT_REPO. Anything that isn't a well-formed owner/name is
 * rejected, so it can never reach a GitHub URL or an Astra filter unchecked.
 */

import { NextResponse } from 'next/server';
import { listBranches } from '@/lib/github';
import { parseRepoKey, splitRepo, type RepoKey } from './types';

/** The configured default repo, or null when WIKI_DEFAULT_REPO is unset/invalid. */
export function getDefaultRepo(): RepoKey | null {
  return parseRepoKey(process.env.WIKI_DEFAULT_REPO);
}

export type RepoResolution = { ok: true; repo: RepoKey } | { ok: false; response: NextResponse };

/** Validate a raw `repo` value (query param or body field), falling back to the default repo. */
export function resolveRepo(raw: unknown): RepoResolution {
  if (typeof raw === 'string' && raw.trim()) {
    const repo = parseRepoKey(raw);
    if (!repo) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'repo must look like "owner/name".' }, { status: 400 }),
      };
    }
    return { ok: true, repo };
  }
  const fallback = getDefaultRepo();
  if (!fallback) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'repo is required (or set WIKI_DEFAULT_REPO to "owner/name").' },
        { status: 400 },
      ),
    };
  }
  return { ok: true, repo: fallback };
}

/**
 * The branch a request is about: the one it names, else the repo's own default
 * branch (not every repo uses "main"). Falls back to "main" if GitHub can't say.
 */
export async function resolveBranch(repo: RepoKey, raw: unknown): Promise<string> {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  try {
    const { owner, name } = splitRepo(repo);
    return (await listBranches(owner, name)).defaultBranch;
  } catch {
    return 'main';
  }
}

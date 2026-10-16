/**
 * snapshot.ts — PURE snapshot encode/decode and diff.
 *
 * No I/O. Operates only on in-memory strings and arrays.
 *
 * File list compact format: `<blobSha> <path>\n` (one line per file).
 * blobSha is the 40-char hex git blob SHA from the GitHub tree API.
 */

import type { SnapshotDiff, SnapshotEntry } from './types';

/**
 * Encode an array of snapshot entries into the compact file list text.
 * Entries are sorted by path so the text is deterministic.
 */
export function encodeFileList(entries: SnapshotEntry[]): string {
  return entries
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.sha} ${e.path}`)
    .join('\n');
}

/**
 * Decode compact file list text back into an array of SnapshotEntry.
 * Blank lines and malformed lines are silently skipped.
 */
export function decodeFileList(text: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx < 1) continue;
    const sha = trimmed.slice(0, spaceIdx);
    const path = trimmed.slice(spaceIdx + 1);
    if (sha && path) entries.push({ sha, path });
  }
  return entries;
}

/**
 * Diff two file lists (old vs new).
 *
 * Algorithm:
 *   1. Build maps: path→sha and sha→path for each side.
 *   2. Renames: sha present in both old and new, but with a different path.
 *      When one old sha maps to exactly one new path (and the old path is gone),
 *      it's a rename.
 *   3. Deletions: paths in old that are neither in new nor accounted for as a rename old-path.
 *   4. Additions: paths in new that are neither in old nor accounted for as a rename new-path.
 *   5. Modifications: same path in both, different sha (not a rename).
 */
export function diffSnapshots(
  oldEntries: SnapshotEntry[],
  newEntries: SnapshotEntry[],
): SnapshotDiff {
  const oldByPath = new Map<string, string>(); // path → sha
  const newByPath = new Map<string, string>();
  const oldBySha = new Map<string, string[]>(); // sha → paths[]
  const newBySha = new Map<string, string[]>();

  for (const e of oldEntries) {
    oldByPath.set(e.path, e.sha);
    const arr = oldBySha.get(e.sha) ?? [];
    arr.push(e.path);
    oldBySha.set(e.sha, arr);
  }
  for (const e of newEntries) {
    newByPath.set(e.path, e.sha);
    const arr = newBySha.get(e.sha) ?? [];
    arr.push(e.path);
    newBySha.set(e.sha, arr);
  }

  const renames: SnapshotDiff['renames'] = [];
  const renamedOldPaths = new Set<string>();
  const renamedNewPaths = new Set<string>();

  // Find renames: sha appears in both sides, but path changed (1-to-1 only).
  for (const [sha, oldPaths] of oldBySha) {
    const newPaths = newBySha.get(sha);
    if (!newPaths) continue;
    // For 1-to-1 renames we pick paths that are exclusively moved (not present on both sides).
    const disappearedOldPaths = oldPaths.filter((p) => !newByPath.has(p));
    const appearedNewPaths = newPaths.filter((p) => !oldByPath.has(p));
    // Pair them up in order (best-effort for 1-to-many; only emit if counts match exactly).
    if (disappearedOldPaths.length === appearedNewPaths.length && disappearedOldPaths.length > 0) {
      for (let i = 0; i < disappearedOldPaths.length; i++) {
        renames.push({ oldPath: disappearedOldPaths[i], newPath: appearedNewPaths[i], sha });
        renamedOldPaths.add(disappearedOldPaths[i]);
        renamedNewPaths.add(appearedNewPaths[i]);
      }
    }
  }

  const deletions: SnapshotEntry[] = [];
  for (const [path, sha] of oldByPath) {
    if (!newByPath.has(path) && !renamedOldPaths.has(path)) {
      deletions.push({ sha, path });
    }
  }

  const additions: SnapshotEntry[] = [];
  const modifications: SnapshotEntry[] = [];
  for (const [path, sha] of newByPath) {
    if (renamedNewPaths.has(path)) continue;
    if (!oldByPath.has(path)) {
      additions.push({ sha, path });
    } else if (oldByPath.get(path) !== sha) {
      modifications.push({ sha, path });
    }
  }

  return { additions, deletions, renames, modifications };
}

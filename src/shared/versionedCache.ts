// A global cache laid out as `<root>/<version>/<rid>/`, used for both the downloaded language
// server and the downloaded debug adapter. Old versions are pruned after a successful download so
// they don't accumulate across version bumps.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Which cached version directories may be pruned: every one except the version currently in use.
 * Pure (no IO) so it stays unit-testable. If `keep` is not among `existing` (e.g. an override path
 * is in use) nothing is held back — but callers only prune right after a real download of `keep`,
 * so in practice `keep` is always present.
 */
export function versionsToPrune(existing: readonly string[], keep: string): string[] {
  return existing.filter((v) => v !== keep);
}

/**
 * Removes every cached version under `rootDir` except `keepVersion`. Best-effort: a missing root or
 * a failed individual removal is ignored, since callers run this fire-and-forget. Returns the
 * version folder names that were removed, for logging.
 */
export async function pruneVersionCache(rootDir: string, keepVersion: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const removed: string[] = [];
  for (const name of versionsToPrune(names, keepVersion)) {
    try {
      await fsp.rm(path.join(rootDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Leave a version we couldn't remove; it will be retried on a later start.
    }
  }
  return removed;
}

export async function clearVersionCache(rootDir: string): Promise<void> {
  await fsp.rm(rootDir, { recursive: true, force: true });
}

// How long each test took last time, so the dashboard can estimate a run before it has finished a
// single test. Pure and serialisable: this module never touches a Memento — the dashboard reads the
// blob, hands it here, and writes back what comes out. That keeps every rule about merging, ageing
// and pruning unit-testable.
//
// Keyed by `vscode.TestItem.id` (`methodIdFor(projectFsPath, className, method)`), which is already
// stable and already project-scoped, so renaming or removing a project drops its entries naturally.

export interface DurationEntry {
  ms: number;
  /** The run counter when this test was last seen; drives pruning. */
  run: number;
}

export interface DurationCacheData {
  version: 1;
  /** Incremented once per merged run. */
  run: number;
  entries: Record<string, DurationEntry>;
}

export const EMPTY_CACHE: DurationCacheData = { version: 1, run: 0, entries: {} };

/** Weight of the newest measurement. One slow machine moment must not become the prediction. */
const NEW_WEIGHT = 0.6;

/** Entries kept before the least-recently-seen are dropped. A Memento is not a database. */
const MAX_ENTRIES = 5000;

/**
 * Narrows whatever the Memento held. Anything unrecognised yields an empty cache rather than an
 * error: a stale or hand-edited blob must cost the user an ETA, not a broken test run.
 */
export function readCache(raw: unknown): DurationCacheData {
  if (typeof raw !== "object" || raw === null) {
    return EMPTY_CACHE;
  }
  const candidate = raw as Partial<DurationCacheData>;
  if (candidate.version !== 1 || typeof candidate.entries !== "object" || candidate.entries === null) {
    return EMPTY_CACHE;
  }
  const entries: Record<string, DurationEntry> = {};
  for (const [id, entry] of Object.entries(candidate.entries as Record<string, unknown>)) {
    const parsed = readEntry(entry);
    if (parsed) {
      entries[id] = parsed;
    }
  }
  return { version: 1, run: isCount(candidate.run) ? candidate.run : 0, entries };
}

/** The expected duration of a test, if it has ever been seen. */
export function predict(cache: DurationCacheData, testId: string): number | undefined {
  return cache.entries[testId]?.ms;
}

/** Folds one run's durations in, bumps the run counter and prunes. Returns a fresh object. */
export function mergeRun(
  cache: DurationCacheData,
  durations: ReadonlyMap<string, number>,
  maxEntries: number = MAX_ENTRIES,
): DurationCacheData {
  const run = cache.run + 1;
  const entries: Record<string, DurationEntry> = { ...cache.entries };
  for (const [id, ms] of durations) {
    if (!Number.isFinite(ms) || ms < 0) {
      continue;
    }
    const previous = entries[id];
    entries[id] = {
      ms: previous ? previous.ms * (1 - NEW_WEIGHT) + ms * NEW_WEIGHT : ms,
      run,
    };
  }
  return { version: 1, run, entries: prune(entries, maxEntries) };
}

/** Keeps the most-recently-seen entries. Ties break on id so the result is deterministic. */
function prune(entries: Record<string, DurationEntry>, maxEntries: number): Record<string, DurationEntry> {
  const ids = Object.keys(entries);
  if (ids.length <= maxEntries) {
    return entries;
  }
  const kept = ids
    .sort((a, b) => entries[b].run - entries[a].run || a.localeCompare(b))
    .slice(0, Math.max(0, maxEntries));
  const result: Record<string, DurationEntry> = {};
  for (const id of kept) {
    result[id] = entries[id];
  }
  return result;
}

function readEntry(value: unknown): DurationEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Partial<DurationEntry>;
  if (typeof entry.ms !== "number" || !Number.isFinite(entry.ms) || entry.ms < 0) {
    return undefined;
  }
  return { ms: entry.ms, run: isCount(entry.run) ? entry.run : 0 };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

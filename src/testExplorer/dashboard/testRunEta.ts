// Remaining-time arithmetic for a test run. Pure, in the spirit of languageServer/runTestsProgress.ts:
// every decision a wrong number could come from lives here, where it can be unit-tested.
//
// Two estimators, deliberately kept apart:
//   - "durations": the sum of what each remaining test cost last time, divided by how many projects
//     are actually executing. It needs no completed test at all, so the second run of a suite shows a
//     real number immediately — that is the whole point of the persisted duration cache.
//   - "rate": tests finished per millisecond of *wall clock* since the first completion. It needs no
//     history and gets parallelism for free (wall clock already contains it), but it says nothing
//     until a few tests are in, and nothing at all while the host is still building.
// Neither is smoothed on its own; the blend is an EMA against the previous estimate, because a single
// slow test would otherwise make the number jump around and read as broken.

export type EtaBasis = "none" | "rate" | "durations";

export interface EtaEstimate {
  /** Milliseconds left, or undefined when there is no honest basis for a number yet. */
  remainingMs: number | undefined;
  basis: EtaBasis;
  /** 0..1 for the progress bar; undefined while the total is unknown. */
  fraction: number | undefined;
}

export interface EtaInputs {
  /** When the run started. Only used to keep callers honest — the rate ignores it, see below. */
  startedAt: number;
  /** When the first test finished. Build and discovery time before it must not enter the rate. */
  firstCompletionAt: number | undefined;
  now: number;
  completed: number;
  /** Undefined while any running project cannot say how many tests it has (classic VSTest). */
  total: number | undefined;
  /** Durations observed during this run, in completion order. */
  observedDurations: readonly number[];
  /** One entry per unfinished test: its cached duration, or undefined if never seen before. */
  predictedRemaining: readonly (number | undefined)[];
  /** Projects currently executing tests; the duration estimate is divided by this. */
  activeProjects: number;
  /** The estimate this one replaces. Smoothing is against it. */
  previous: EtaEstimate | undefined;
}

/** Share of the remaining tests we need a cached duration for before "durations" beats "rate". */
const CACHE_COVERAGE_THRESHOLD = 0.5;

/** EMA weight of the new estimate. Low = calm, high = responsive. */
const SMOOTHING = 0.3;

export function estimateEta(input: EtaInputs): EtaEstimate {
  const fraction =
    input.total !== undefined && input.total > 0 ? clamp(input.completed / input.total) : undefined;
  const raw = rawEstimate(input);
  if (raw === undefined) {
    return { remainingMs: undefined, basis: "none", fraction };
  }
  // Smoothing only makes sense against a number of the same kind; switching basis starts fresh.
  const previous = input.previous?.basis === raw.basis ? input.previous.remainingMs : undefined;
  const smoothed = previous === undefined ? raw.ms : previous * (1 - SMOOTHING) + raw.ms * SMOOTHING;
  return { remainingMs: Math.max(0, Math.round(smoothed)), basis: raw.basis, fraction };
}

function rawEstimate(input: EtaInputs): { ms: number; basis: EtaBasis } | undefined {
  if (input.total === undefined || input.total <= 0) {
    return undefined;
  }
  const remaining = Math.max(0, input.total - input.completed);
  if (remaining === 0) {
    return { ms: 0, basis: input.previous?.basis === "durations" ? "durations" : "rate" };
  }

  const known = input.predictedRemaining.filter((ms): ms is number => ms !== undefined);
  const coverage = input.predictedRemaining.length > 0 ? known.length / input.predictedRemaining.length : 0;
  // The fallback fills the gaps in a partly-cached suite: what this run has shown so far, or failing
  // that what the cache says about the tests it does know.
  const fallback = median(input.observedDurations) ?? median(known);
  if (coverage >= CACHE_COVERAGE_THRESHOLD && fallback !== undefined) {
    const total = input.predictedRemaining.reduce<number>((sum, ms) => sum + (ms ?? fallback), 0);
    return { ms: total / Math.max(1, input.activeProjects), basis: "durations" };
  }

  // Measured from the first completion, not from the run's start: a host that spent eight seconds
  // building would otherwise make the first estimate absurd and it would take minutes to recover.
  if (input.completed === 0 || input.firstCompletionAt === undefined) {
    return undefined;
  }
  const elapsed = Math.max(1, input.now - input.firstCompletionAt);
  return { ms: (elapsed / input.completed) * remaining, basis: "rate" };
}

/** Median, not mean: one 30-second integration test must not distort 500 fast unit tests. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `0s`, `1.2s`, `47s`, `3m 05s`, `1h 02m`. Sub-10s keeps a decimal; above that it is noise. */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe === 0) {
    return "0s";
  }
  if (safe < 10_000) {
    return `${(Math.floor(safe / 100) / 10).toFixed(1)}s`;
  }
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${pad(seconds % 60)}s`;
  }
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/**
 * The ETA line. The wording carries the basis: a rate-based guess early in a run really is a guess,
 * and saying so is cheaper than being confidently wrong.
 */
export function formatEta(estimate: EtaEstimate): string {
  if (estimate.remainingMs === undefined) {
    return "estimating…";
  }
  if (estimate.remainingMs < 1000) {
    return "almost done";
  }
  const time = formatDuration(estimate.remainingMs);
  return estimate.basis === "durations" ? `about ${time} remaining` : `roughly ${time} remaining`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

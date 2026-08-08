// Decides what to do when the Roslyn server process dies on its own (an unhandled exception in a
// request handler aborts the process — the client then sees the pipe close). Pure logic so the
// controller stays free of timing rules and this can be unit-tested without vscode.

export interface CrashPolicy {
  /** How many automatic restarts are allowed inside `windowMs`. */
  maxRestarts: number;
  /** Rolling window the crashes are counted in. */
  windowMs: number;
  /** Backoff before the n-th restart; the last entry repeats. */
  delaysMs: readonly number[];
}

/**
 * Four restarts inside three minutes, with a growing backoff. A one-off crash (Roslyn aborting on a
 * single bad request) recovers invisibly; a server that dies on every start gives up quickly instead
 * of looping — the three-minute window also means a server that crashes once an hour keeps recovering.
 */
export const DEFAULT_CRASH_POLICY: CrashPolicy = {
  maxRestarts: 4,
  windowMs: 3 * 60_000,
  delaysMs: [1_000, 3_000, 10_000, 30_000],
};

export type CrashDecision =
  | { kind: "restart"; attempt: number; delayMs: number }
  /** Too many crashes in the window — stay down and tell the user. */
  | { kind: "giveUp"; crashes: number; windowMs: number };

/** Counts crashes in a rolling window and answers whether to restart again. */
export class CrashTracker {
  private crashes: number[] = [];

  constructor(private readonly policy: CrashPolicy = DEFAULT_CRASH_POLICY) {}

  /** Records a crash at `now` (epoch ms) and returns what should happen next. */
  record(now: number): CrashDecision {
    this.crashes = this.crashes.filter((at) => now - at < this.policy.windowMs);
    this.crashes.push(now);
    const attempt = this.crashes.length;
    if (attempt > this.policy.maxRestarts) {
      return { kind: "giveUp", crashes: attempt, windowMs: this.policy.windowMs };
    }
    const delays = this.policy.delaysMs;
    return { kind: "restart", attempt, delayMs: delays[Math.min(attempt - 1, delays.length - 1)] ?? 0 };
  }

  /** Forgets the history — used when the user starts/stops the server explicitly. */
  reset(): void {
    this.crashes = [];
  }
}

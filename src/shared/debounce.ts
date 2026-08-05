// Trailing-edge debouncing: rapid calls (file-watcher bursts, keystrokes) collapse into one. Two
// flavours — `debounce` keeps the last arguments, `debounceCollect` keeps every item of the burst.
// Pure — no vscode — so they stay unit-testable and reusable across subsystems.
//
// Both return a `cancel()` alongside the call, because a trailing call outlives whatever scheduled
// it: a watcher event arriving just before shutdown would otherwise fire its callback after the
// owner has been disposed. An owner that disposes mid-window must cancel.

/** A debounced call. `cancel()` drops a pending trailing call; calling again afterwards re-arms it. */
export type Debounced<A extends unknown[]> = ((...args: A) => void) & { cancel(): void };

/** A throttled call. `flush()` runs a pending trailing call now; `cancel()` drops it. */
export type Throttled<A extends unknown[]> = ((...args: A) => void) & { cancel(): void; flush(): void };

/** A debounced collector. `cancel()` drops the pending call *and* the items collected so far. */
export type DebouncedCollector<T> = ((item: T) => void) & { cancel(): void };

/** Debounces a void-returning function so rapid calls collapse into the last one, after `ms` of quiet. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: NodeJS.Timeout | undefined;
  return Object.assign(
    (...args: A): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => fn(...args), ms);
    },
    {
      cancel: (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
    },
  );
}

/**
 * Rate-limits a void-returning function to one call per `ms`, on both edges of the window.
 *
 * Debouncing would be wrong for a continuous stream: every event re-arms the timer, so a run
 * reporting a test every few milliseconds would show nothing at all until it finished. A throttle
 * lets the first call through immediately and collapses the rest of the window into one trailing
 * call, which is what keeps a live view live without flooding it.
 *
 * `flush()` exists for the end of a stream: the final state must land even if it arrived inside a
 * window that has not closed yet.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let timer: NodeJS.Timeout | undefined;
  let pending: A | undefined;

  const run = (args: A): void => {
    pending = undefined;
    // Opening the window before the call, so a re-entrant call from `fn` is throttled like any other.
    timer = setTimeout(() => {
      timer = undefined;
      if (pending) {
        run(pending);
      }
    }, ms);
    fn(...args);
  };

  return Object.assign(
    (...args: A): void => {
      if (timer) {
        pending = args;
        return;
      }
      run(args);
    },
    {
      cancel: (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        pending = undefined;
      },
      flush: (): void => {
        if (pending) {
          const args = pending;
          pending = undefined;
          fn(...args);
        }
      },
    },
  );
}

/**
 * Debounces a per-item callback into one call with *every* item seen during the burst.
 *
 * `debounce` keeps only the last arguments, which silently drops work when the items differ: two
 * files saved together are two events, and the first one's path never reaches the callback. Items
 * are collected in a `Set`, so a path that fires repeatedly (a save can emit several events) is
 * still handled once.
 */
export function debounceCollect<T>(fn: (items: T[]) => void, ms: number): DebouncedCollector<T> {
  let timer: NodeJS.Timeout | undefined;
  let pending = new Set<T>();
  return Object.assign(
    (item: T): void => {
      pending.add(item);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        const items = [...pending];
        pending = new Set<T>();
        fn(items);
      }, ms);
    },
    {
      // Items go too: they belong to the cancelled call, and keeping them would leak the discarded
      // burst into whatever the next one collects.
      cancel: (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        pending = new Set<T>();
      },
    },
  );
}

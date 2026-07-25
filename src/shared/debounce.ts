// Trailing-edge debouncing: rapid calls (file-watcher bursts, keystrokes) collapse into one. Two
// flavours — `debounce` keeps the last arguments, `debounceCollect` keeps every item of the burst.
// Pure — no vscode — so they stay unit-testable and reusable across subsystems.

/** Debounces a void-returning function so rapid calls collapse into the last one, after `ms` of quiet. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Debounces a per-item callback into one call with *every* item seen during the burst.
 *
 * `debounce` keeps only the last arguments, which silently drops work when the items differ: two
 * files saved together are two events, and the first one's path never reaches the callback. Items
 * are collected in a `Set`, so a path that fires repeatedly (a save can emit several events) is
 * still handled once.
 */
export function debounceCollect<T>(fn: (items: T[]) => void, ms: number): (item: T) => void {
  let timer: NodeJS.Timeout | undefined;
  let pending = new Set<T>();
  return (item: T) => {
    pending.add(item);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      const items = [...pending];
      pending = new Set<T>();
      fn(items);
    }, ms);
  };
}

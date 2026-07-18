// A single, dependency-free concurrency primitive. Update checks fan out one nuget.org request per
// distinct package, which on a large solution means dozens of simultaneous connections every time the
// panel opens or refreshes. Bounding that keeps us a well-behaved client without giving up the
// parallelism that makes the check fast.

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at a time. Results keep the input
 * order regardless of completion order. The first rejection propagates (like `Promise.all`), so
 * callers that want per-item failure isolation should catch inside `fn`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.floor(limit));
  let next = 0;

  const worker = async (): Promise<void> => {
    // Each worker keeps claiming the next unstarted index until the queue is drained. Reading and
    // incrementing `next` is safe without a lock because it happens synchronously between awaits.
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

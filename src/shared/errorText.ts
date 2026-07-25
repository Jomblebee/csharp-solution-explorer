/**
 * The message a caught `unknown` should show a user. `catch` binds `unknown`, and a rejected promise
 * can carry anything — a string, a spawn error object, `undefined` — so the `Error` case cannot be
 * assumed. Kept in one place because every subsystem that reports a failure needs the same two lines.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

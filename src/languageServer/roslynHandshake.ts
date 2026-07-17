// Pure decision for the non-standard Roslyn "open workspace" handshake: after `initialize`, the
// server must be told what to load. A solution wins if present (`solution/open`); otherwise the
// loose projects are opened (`project/open`). Kept free of `vscode`/IO so it is unit-testable — the
// client does the file discovery and URI conversion around it.

export type HandshakeAction =
  | { kind: "solution"; solution: string }
  | { kind: "projects"; projects: string[] }
  | { kind: "none" };

/**
 * Chooses the open action from discovered files. `solutions` and `projects` are fsPaths and are
 * expected pre-sorted by preference (e.g. shallowest first); the first solution is used when any
 * exists. Returns `none` when there is nothing to open.
 */
export function decideHandshake(solutions: string[], projects: string[]): HandshakeAction {
  if (solutions.length > 0) {
    return { kind: "solution", solution: solutions[0] };
  }
  if (projects.length > 0) {
    return { kind: "projects", projects };
  }
  return { kind: "none" };
}

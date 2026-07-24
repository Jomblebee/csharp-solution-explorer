// Pure decision for the non-standard Roslyn "open workspace" handshake: after `initialize`, the
// server must be told what to load. The `loadMode` setting (plus an optional explicit solution path)
// selects the entry point; Roslyn then pulls in referenced projects on its own. Kept free of
// `vscode`/IO so it is unit-testable — the client does the file discovery and URI conversion around it.

export type HandshakeAction =
  | { kind: "solution"; solution: string }
  | { kind: "projects"; projects: string[] }
  | { kind: "none" };

/**
 * How to choose what the server loads:
 * - `auto`: an explicit/discovered solution wins, otherwise all loose projects (the default).
 * - `solution`: only ever open a solution; never fall back to loose projects.
 * - `projects`: always open all discovered projects, ignoring any solution.
 * - `openProjects`: open only the projects that own the currently-open editors (their referenced
 *   projects still load automatically).
 */
export type LoadMode = "auto" | "solution" | "projects" | "openProjects";

export interface HandshakeInput {
  mode: LoadMode;
  /** Discovered `.sln`/`.slnx` fsPaths, pre-sorted by preference (shallowest first). */
  solutions: string[];
  /** Discovered `.csproj` fsPaths, pre-sorted by preference. */
  projects: string[];
  /** `.csproj` fsPaths owning the currently-open editors (used only by `openProjects`). */
  openProjects: string[];
  /** An explicit, already-resolved solution fsPath that overrides discovery; `""`/absent = none. */
  solutionPath?: string;
}

/** Chooses the open action for the given mode and discovered files. Returns `none` when empty. */
export function decideHandshake(input: HandshakeInput): HandshakeAction {
  const { mode, solutions, projects, openProjects, solutionPath } = input;

  switch (mode) {
    case "projects":
      return projects.length > 0 ? { kind: "projects", projects } : { kind: "none" };
    case "openProjects":
      return openProjects.length > 0 ? { kind: "projects", projects: openProjects } : { kind: "none" };
    case "solution": {
      const solution = pickSolution(solutions, solutionPath);
      return solution ? { kind: "solution", solution } : { kind: "none" };
    }
    case "auto": {
      const solution = pickSolution(solutions, solutionPath);
      if (solution) {
        return { kind: "solution", solution };
      }
      return projects.length > 0 ? { kind: "projects", projects } : { kind: "none" };
    }
  }
}

/** An explicit solution path wins outright; otherwise the first (shallowest) discovered solution. */
function pickSolution(solutions: string[], solutionPath?: string): string | undefined {
  const explicit = solutionPath?.trim();
  if (explicit) {
    return explicit;
  }
  return solutions[0];
}

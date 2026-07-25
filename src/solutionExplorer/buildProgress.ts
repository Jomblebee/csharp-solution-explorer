import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseProjectReferences } from "./parsers/csprojReader.js";

/** One meaningful event parsed out of a single line of `dotnet build` stdout. */
export type BuildLineEvent = { kind: "restoreDone" } | { kind: "projectDone"; name: string } | { kind: "other" };

// MSBuild's classic, verbosity-independent "done" line, e.g. `MyProject -> C:\...\MyProject.dll`.
// Anchored on a .dll/.exe suffix so ordinary log text can't false-positive on a stray "->".
const PROJECT_DONE_PATTERN = /^\s*(?<name>.+?)\s*->\s*(?<out>.+\.(?:dll|exe))\s*$/i;
const RESTORE_DONE_PATTERN = /\bRestored\b|\brestore complete\b|\bup-to-date for restore\b/i;
const MAX_PARSED_LINE_LENGTH = 4096;

/** Classifies one line of `dotnet build` stdout. Pure — no I/O, safe to unit test directly. */
export function parseBuildLine(line: string): BuildLineEvent | undefined {
  if (line.length === 0) {
    return undefined;
  }
  if (line.length > MAX_PARSED_LINE_LENGTH) {
    return { kind: "other" };
  }
  const doneMatch = PROJECT_DONE_PATTERN.exec(line);
  if (doneMatch?.groups?.name) {
    return { kind: "projectDone", name: doneMatch.groups.name.trim() };
  }
  if (RESTORE_DONE_PATTERN.test(line)) {
    return { kind: "restoreDone" };
  }
  return { kind: "other" };
}

export interface BuildProgressState {
  totalProjects: number;
  completedProjects: Set<string>;
  restoreSeen: boolean;
  compilingSeen: boolean;
}

export function createBuildProgressState(totalProjects: number): BuildProgressState {
  return { totalProjects: Math.max(1, totalProjects), completedProjects: new Set(), restoreSeen: false, compilingSeen: false };
}

/**
 * Advances progress state from one parsed line event and returns the resulting overall
 * fraction/message. Pure — no I/O, safe to unit test directly. `fraction` never decreases across
 * calls for the same state, and reaches exactly 1 once every project in the graph has completed.
 */
export function computeProgress(state: BuildProgressState, event: BuildLineEvent): { fraction: number; message: string } {
  if (event.kind === "restoreDone") {
    state.restoreSeen = true;
  } else if (event.kind === "projectDone") {
    state.completedProjects.add(event.name);
    state.compilingSeen = true;
  } else if (state.restoreSeen) {
    state.compilingSeen = true;
  }

  const completed = Math.min(state.completedProjects.size, state.totalProjects);
  if (completed >= state.totalProjects) {
    return { fraction: 1, message: "Build succeeded." };
  }

  const innerFraction = completed > 0 || state.compilingSeen ? 0.7 : state.restoreSeen ? 0.15 : 0;
  const fraction = (completed + innerFraction) / state.totalProjects;
  const message =
    innerFraction >= 0.7
      ? state.totalProjects > 1
        ? `Compiling… (${completed}/${state.totalProjects} projects built)`
        : "Compiling…"
      : state.restoreSeen
        ? "Restoring…"
        : "Building…";
  return { fraction, message };
}

/**
 * Counts the target project plus every project it transitively references, by statically walking
 * `<ProjectReference>` elements — no MSBuild graph query, just local file reads, so it's cheap enough
 * to run before every F5 build purely to size the progress bar. Falls back to 1 (single project) on
 * any read error or cycle, since a wrong project count degrades progress feel, not build correctness.
 */
export async function countProjectGraph(targetFsPath: string): Promise<number> {
  const visited = new Set<string>();
  async function visit(fsPath: string): Promise<void> {
    const resolved = path.resolve(fsPath);
    if (visited.has(resolved)) {
      return;
    }
    visited.add(resolved);
    let text: string;
    try {
      text = await fs.readFile(resolved, "utf8");
    } catch {
      return;
    }
    for (const ref of parseProjectReferences(text)) {
      await visit(path.resolve(path.dirname(resolved), ref.relativePath));
    }
  }
  try {
    await visit(targetFsPath);
    return visited.size || 1;
  } catch {
    return 1;
  }
}

// Pure enumeration of a solution's projects, independent of the tree UI and of vscode/FS (so it is
// unit-testable). The NuGet manager needs the flat project list for its solution-wide checklist; the
// FS-touching wrapper that resolves these to on-disk .csproj URIs lives in the manager service.

import { isLikelyCsproj } from "../solutionExplorer/parsers/csprojReader.js";
import { parseSlnxFile } from "../solutionExplorer/parsers/slnxParser.js";
import {
  buildSolutionTree,
  parseNestedProjects,
  parseSolutionFile,
  ProjectNode,
  SolutionTreeNode,
} from "../solutionExplorer/parsers/slnParser.js";

export interface SolutionProject {
  name: string;
  /** The project file's path relative to the solution directory, in POSIX form. */
  relativePath: string;
}

/** Depth-first walk collecting every project node under `nodes` (recursing solution folders). */
export function flattenProjectNodes(nodes: SolutionTreeNode[]): ProjectNode[] {
  const projects: ProjectNode[] = [];
  for (const node of nodes) {
    if (node.kind === "solutionFolder") {
      projects.push(...flattenProjectNodes(node.children));
    } else {
      projects.push(node);
    }
  }
  return projects;
}

/**
 * Parses a solution file's text into its project list. `isSlnx` selects the XML (.slnx) or the
 * classic (.sln) parser. Non-project entries and non-`.csproj`-like paths are dropped.
 */
export function parseSolutionProjects(text: string, isSlnx: boolean): SolutionProject[] {
  const tree = isSlnx ? parseSlnxFile(text) : buildSolutionTree(parseSolutionFile(text), parseNestedProjects(text));
  return flattenProjectNodes(tree)
    .filter((node) => isLikelyCsproj(node.relativePath))
    .map((node) => ({ name: node.name, relativePath: node.relativePath }));
}

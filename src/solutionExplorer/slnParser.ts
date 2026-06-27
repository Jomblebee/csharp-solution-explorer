export interface ParsedProjectReference {
  typeGuid: string;
  name: string;
  relativePath: string;
  projectGuid: string;
}

const PROJECT_LINE_PATTERN =
  /^Project\("(\{[0-9A-Fa-f-]+\})"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"(\{[0-9A-Fa-f-]+\})"\s*$/gim;

export const SOLUTION_FOLDER_TYPE_GUID = "{2150E333-8FDC-42A3-9474-1A3956D46DE8}";

/**
 * Parses a .sln file's text content and returns every `Project(...)` entry found,
 * including solution-folder pseudo-entries (filtering those out is the caller's job).
 * Relative paths are normalized from Windows-style backslashes to forward slashes.
 */
export function parseSolutionFile(slnText: string): ParsedProjectReference[] {
  const results: ParsedProjectReference[] = [];

  for (const match of slnText.matchAll(PROJECT_LINE_PATTERN)) {
    const [, typeGuid, name, relativePath, projectGuid] = match;
    results.push({
      typeGuid,
      name,
      relativePath: relativePath.replace(/\\/g, "/"),
      projectGuid,
    });
  }

  return results;
}

const NESTED_PROJECTS_SECTION_PATTERN =
  /GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i;
const NESTED_PROJECT_LINE_PATTERN = /(\{[0-9A-Fa-f-]+\})\s*=\s*(\{[0-9A-Fa-f-]+\})/g;

/**
 * Parses the `GlobalSection(NestedProjects)` block of a .sln file, which records
 * which projects/solution folders are nested under which solution folder
 * (`{childGuid} = {parentGuid}`). Returns an empty map if the section is absent.
 */
export function parseNestedProjects(slnText: string): Map<string, string> {
  const nesting = new Map<string, string>();
  const sectionMatch = NESTED_PROJECTS_SECTION_PATTERN.exec(slnText);
  if (!sectionMatch) {
    return nesting;
  }

  for (const [, child, parent] of sectionMatch[1].matchAll(NESTED_PROJECT_LINE_PATTERN)) {
    nesting.set(child, parent);
  }

  return nesting;
}

export interface ProjectNode {
  kind: "project";
  guid: string;
  name: string;
  relativePath: string;
}

export interface SolutionFolderNode {
  kind: "solutionFolder";
  guid: string;
  name: string;
  children: SolutionTreeNode[];
}

export type SolutionTreeNode = ProjectNode | SolutionFolderNode;

/**
 * Combines the flat list of parsed project references with the nesting map
 * into a tree, grouping projects/folders under their parent solution folder.
 * Entries with no parent (or whose parent isn't a solution folder) become roots.
 */
export function buildSolutionTree(
  references: ParsedProjectReference[],
  nesting: Map<string, string>,
): SolutionTreeNode[] {
  const nodesByGuid = new Map<string, SolutionTreeNode>();
  for (const ref of references) {
    nodesByGuid.set(
      ref.projectGuid,
      ref.typeGuid === SOLUTION_FOLDER_TYPE_GUID
        ? { kind: "solutionFolder", guid: ref.projectGuid, name: ref.name, children: [] }
        : { kind: "project", guid: ref.projectGuid, name: ref.name, relativePath: ref.relativePath },
    );
  }

  const roots: SolutionTreeNode[] = [];
  for (const node of nodesByGuid.values()) {
    const parent = nodesByGuid.get(nesting.get(node.guid) ?? "");
    if (parent?.kind === "solutionFolder") {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

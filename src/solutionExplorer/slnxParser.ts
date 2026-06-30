import { ProjectNode, SolutionFolderNode, SolutionTreeNode } from "./slnParser.js";

/**
 * Post-processes a flat list of SolutionTreeNodes and groups any SolutionFolderNodes
 * whose names contain "/" into a proper nested hierarchy of virtual path-segment folders.
 *
 * For example, sibling nodes named "src/base/A" and "src/base/B" become:
 *   SolutionFolderNode "src" (isVirtual)
 *     SolutionFolderNode "base" (isVirtual)
 *       SolutionFolderNode "A"
 *       SolutionFolderNode "B"
 *
 * Nodes without "/" and ProjectNodes pass through unchanged.
 * Insertion order is preserved relative to the first occurrence of each path prefix.
 */
export function nestPathBasedFolders(nodes: SolutionTreeNode[]): SolutionTreeNode[] {
  const result: SolutionTreeNode[] = [];
  const segmentGroups = new Map<string, SolutionFolderNode>();

  for (const node of nodes) {
    if (node.kind === "solutionFolder" && node.name.includes("/")) {
      const slashIdx = node.name.indexOf("/");
      const firstSeg = node.name.substring(0, slashIdx);
      const remainder = node.name.substring(slashIdx + 1);

      let virtualFolder = segmentGroups.get(firstSeg);
      if (!virtualFolder) {
        virtualFolder = {
          kind: "solutionFolder",
          guid: `__virtual__${firstSeg}`,
          name: firstSeg,
          children: [],
          isVirtual: true,
        };
        segmentGroups.set(firstSeg, virtualFolder);
        result.push(virtualFolder);
      }
      virtualFolder.children.push({ ...node, name: remainder, guid: remainder });
    } else {
      result.push(node);
    }
  }

  for (const virtualFolder of segmentGroups.values()) {
    virtualFolder.children = nestPathBasedFolders(virtualFolder.children);
  }

  return result;
}

function deriveProjectName(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.replace(/\.[^.]+$/, "");
}

function stripFolderSlashes(name: string): string {
  return name.replace(/^\/|\/$/g, "");
}

function extractAttr(attrs: string, attrName: string): string | undefined {
  const match = new RegExp(`${attrName}="([^"]*)"`, "i").exec(attrs);
  return match?.[1];
}

/**
 * Parses a .slnx file's text content and returns a SolutionTreeNode[] tree.
 * The .slnx XML schema has only three element types: Solution, Folder, Project.
 * Folder nesting is direct XML containment — no separate nesting section needed.
 * ProjectNode.guid is set to the normalized relativePath (path serves as stable identifier).
 */
export function parseSlnxFile(slnxText: string): SolutionTreeNode[] {
  const roots: SolutionTreeNode[] = [];
  const stack: SolutionFolderNode[] = [];

  const TOKEN_PATTERN = /<(\/?)(\w+)([^>]*)>/g;

  for (const match of slnxText.matchAll(TOKEN_PATTERN)) {
    const [, closing, tagName, rawAttrs] = match;
    const isSelfClosing = rawAttrs.trimEnd().endsWith("/");

    if (tagName === "Project" && !closing) {
      const relativePath = extractAttr(rawAttrs, "Path");
      if (!relativePath) {continue;}

      const normalized = relativePath.replace(/\\/g, "/");
      const node: ProjectNode = {
        kind: "project",
        guid: normalized,
        name: deriveProjectName(normalized),
        relativePath: normalized,
      };

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        roots.push(node);
      }
    } else if (tagName === "Folder" && !closing && !isSelfClosing) {
      const rawName = extractAttr(rawAttrs, "Name") ?? "";
      const folder: SolutionFolderNode = {
        kind: "solutionFolder",
        guid: stripFolderSlashes(rawName),
        name: stripFolderSlashes(rawName),
        children: [],
      };
      stack.push(folder);
    } else if (tagName === "Folder" && closing) {
      const completed = stack.pop();
      if (!completed) {continue;}

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(completed);
      } else {
        roots.push(completed);
      }
    }
  }

  return nestPathBasedFolders(roots);
}

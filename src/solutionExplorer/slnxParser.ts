import { ProjectNode, SolutionFolderNode, SolutionTreeNode } from "./slnParser.js";

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

  return roots;
}

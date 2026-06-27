const PATH_ATTR_PATTERN = /Path="([^"]*)"/i;
const NAME_ATTR_PATTERN = /Name="([^"]*)"/i;
const FOLDER_OPEN_TAG = /<Folder\b[^>]*>/gi;

function leadingIndent(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? "";
}

/** Net change in folder nesting depth contributed by a line, counting every tag it contains.
 * Self-closing folders and inline open/close pairs net to zero. */
function netFolderDepth(line: string): number {
  let opens = 0;
  for (const match of line.matchAll(FOLDER_OPEN_TAG)) {
    if (!match[0].replace(/\s+/g, "").endsWith("/>")) {
      opens++;
    }
  }
  const closes = (line.match(/<\/Folder>/gi) ?? []).length;
  return opens - closes;
}

/** Finds the line index of the (non-self-closing) `<Folder>` open tag whose Name is `/name/`. */
function findFolderOpenLine(lines: string[], normalizedName: string): number {
  return lines.findIndex((line) => {
    for (const match of line.matchAll(FOLDER_OPEN_TAG)) {
      if (match[0].replace(/\s+/g, "").endsWith("/>")) {
        continue;
      }
      if (NAME_ATTR_PATTERN.exec(match[0])?.[1].toLowerCase() === normalizedName) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Inserts a new (empty) solution folder into a .slnx file. Empty folders are written as an
 * open/close pair (`<Folder Name="/x/"></Folder>`) rather than self-closing, since the parser
 * only treats non-self-closing folders as nodes. When `parentFolderName` is given, the folder is
 * nested inside that parent (matched by its `/Name/`); an inline-empty parent is expanded across
 * lines to receive the child. Otherwise the folder is added at the solution root, before
 * `</Solution>`. Preserves original line endings. No-op if the insertion point cannot be located.
 */
export function addSlnxFolderEntry(slnxText: string, folderName: string, parentFolderName?: string): string {
  const newline = slnxText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnxText.split(/\r\n|\n/);
  const folderLine = (indent: string) => `${indent}<Folder Name="/${folderName}/"></Folder>`;

  if (!parentFolderName) {
    const closeIdx = lines.findIndex((line) => line.includes("</Solution>"));
    if (closeIdx === -1) {
      return slnxText;
    }
    lines.splice(closeIdx, 0, folderLine(`${leadingIndent(lines[closeIdx])}  `));
    return lines.join(newline);
  }

  const parentIdx = findFolderOpenLine(lines, `/${parentFolderName}/`.toLowerCase());
  if (parentIdx === -1) {
    return slnxText;
  }

  const parentIndent = leadingIndent(lines[parentIdx]);
  let depth = 0;
  for (let i = parentIdx; i < lines.length; i++) {
    depth += netFolderDepth(lines[i]);
    if (depth !== 0) {
      continue;
    }
    if (i === parentIdx) {
      // Inline-empty parent (`<Folder Name="/x/"></Folder>`): expand it to hold the child.
      const parentLine = lines[parentIdx];
      const openTag = parentLine.slice(0, parentLine.indexOf(">") + 1);
      lines.splice(parentIdx, 1, openTag, folderLine(`${parentIndent}  `), `${parentIndent}</Folder>`);
    } else {
      lines.splice(i, 0, folderLine(`${parentIndent}  `));
    }
    return lines.join(newline);
  }

  return slnxText;
}

/**
 * Inserts a new `<Project Path="..." />` element into a .slnx file. When `parentFolderName` is given
 * the project is nested inside that solution folder (matched by its `/Name/`); an inline-empty parent
 * is expanded across lines to receive the child. Otherwise the project is added at the solution root,
 * before `</Solution>`. Preserves original line endings. No-op if the insertion point cannot be located.
 */
export function addSlnxProjectEntry(slnxText: string, projectPath: string, parentFolderName?: string): string {
  const newline = slnxText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnxText.split(/\r\n|\n/);
  const projectLine = (indent: string) => `${indent}<Project Path="${projectPath}" />`;

  if (!parentFolderName) {
    const closeIdx = lines.findIndex((line) => line.includes("</Solution>"));
    if (closeIdx === -1) {
      return slnxText;
    }
    lines.splice(closeIdx, 0, projectLine(`${leadingIndent(lines[closeIdx])}  `));
    return lines.join(newline);
  }

  const parentIdx = findFolderOpenLine(lines, `/${parentFolderName}/`.toLowerCase());
  if (parentIdx === -1) {
    return slnxText;
  }

  const parentIndent = leadingIndent(lines[parentIdx]);
  let depth = 0;
  for (let i = parentIdx; i < lines.length; i++) {
    depth += netFolderDepth(lines[i]);
    if (depth !== 0) {
      continue;
    }
    if (i === parentIdx) {
      // Inline-empty parent (`<Folder Name="/x/"></Folder>`): expand it to hold the child.
      const parentLine = lines[parentIdx];
      const openTag = parentLine.slice(0, parentLine.indexOf(">") + 1);
      lines.splice(parentIdx, 1, openTag, projectLine(`${parentIndent}  `), `${parentIndent}</Folder>`);
    } else {
      lines.splice(i, 0, projectLine(`${parentIndent}  `));
    }
    return lines.join(newline);
  }

  return slnxText;
}

/**
 * Removes the <Project Path="..."> line whose Path attribute matches projectPath
 * (case-insensitive). Preserves original line endings. No-op if path is not found.
 */
export function removeSlnxProjectEntry(slnxText: string, projectPath: string): string {
  const newline = slnxText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnxText.split(/\r\n|\n/);
  const normalizedTarget = projectPath.replace(/\\/g, "/").toLowerCase();

  const result = lines.filter((line) => {
    if (!line.includes("<Project")) {return true;}
    const match = PATH_ATTR_PATTERN.exec(line);
    if (!match) {return true;}
    return match[1].replace(/\\/g, "/").toLowerCase() !== normalizedTarget;
  });

  return result.join(newline);
}

/**
 * Updates the Path attribute of the <Project> element matching oldPath to newPath.
 * Preserves indentation, other attributes, and original line endings.
 */
export function renameSlnxProjectEntry(slnxText: string, oldPath: string, newPath: string): string {
  const newline = slnxText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnxText.split(/\r\n|\n/);
  const normalizedOld = oldPath.replace(/\\/g, "/").toLowerCase();

  const result = lines.map((line) => {
    if (!line.includes("<Project")) {return line;}
    const match = PATH_ATTR_PATTERN.exec(line);
    if (!match) {return line;}
    if (match[1].replace(/\\/g, "/").toLowerCase() !== normalizedOld) {return line;}
    return line.replace(PATH_ATTR_PATTERN, `Path="${newPath}"`);
  });

  return result.join(newline);
}

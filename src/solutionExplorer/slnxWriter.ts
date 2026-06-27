const PATH_ATTR_PATTERN = /Path="([^"]*)"/i;

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

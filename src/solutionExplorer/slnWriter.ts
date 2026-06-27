const PROJECT_HEADER_PATTERN =
  /^Project\("(\{[0-9A-Fa-f-]+\})"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"(\{[0-9A-Fa-f-]+\})"\s*$/i;

/**
 * Removes the `Project(...)` ... `EndProject` block for the given GUID, along with
 * its `{guid}.*` lines in `GlobalSection(ProjectConfigurationPlatforms)` and its
 * `{guid} = {parentGuid}` line in `GlobalSection(NestedProjects)`. Leaves the rest of
 * the file (including the original line-ending style) untouched.
 */
export function removeProjectEntry(slnText: string, projectGuid: string): string {
  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnText.split(/\r\n|\n/);

  const headerIndex = lines.findIndex((line) => {
    const match = PROJECT_HEADER_PATTERN.exec(line.trim());
    return match?.[4] === projectGuid;
  });

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === headerIndex) {
      // Skip every line through the matching EndProject (blocks don't nest).
      while (i < lines.length && lines[i].trim() !== "EndProject") {
        i++;
      }
      continue;
    }

    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${projectGuid}.`) || trimmed.startsWith(`${projectGuid} =`)) {
      continue;
    }

    result.push(lines[i]);
  }

  return result.join(newline);
}

/**
 * Updates the `name` and `relativePath` fields of the `Project(...)` header line for
 * the given GUID, leaving the type GUID, project GUID, and surrounding file untouched.
 */
export function renameProjectEntry(
  slnText: string,
  projectGuid: string,
  newName: string,
  newRelativePath: string,
): string {
  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const lines = slnText.split(/\r\n|\n/);

  const updated = lines.map((line) => {
    const match = PROJECT_HEADER_PATTERN.exec(line.trim());
    if (match?.[4] !== projectGuid) {
      return line;
    }

    const indent = line.slice(0, line.indexOf("Project("));
    return `${indent}Project("${match[1]}") = "${newName}", "${newRelativePath}", "${match[4]}"`;
  });

  return updated.join(newline);
}

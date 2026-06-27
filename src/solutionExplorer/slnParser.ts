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

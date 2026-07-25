/**
 * Text-based editing of a project file's `<ProjectReference>` items, mirroring the line-oriented,
 * line-ending-preserving approach of slnWriter/slnxWriter (no XML DOM). Paths are written in the
 * Windows-style backslash form Visual Studio and the samples use; removal matches slash-insensitively.
 */

const PROJECT_REFERENCE_LINE_PATTERN = /^\s*<ProjectReference\b[^>]*\/?>/i;
const INCLUDE_ATTR_PATTERN = /Include\s*=\s*"([^"]*)"/i;
const ITEM_GROUP_OPEN_PATTERN = /^\s*<ItemGroup\b[^>]*>\s*$/i;

function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function leadingIndent(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? "";
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function projectReferenceLine(indent: string, includePath: string): string {
  return `${indent}<ProjectReference Include="${includePath}" />`;
}

/**
 * Adds a `<ProjectReference Include="includePath" />` element. When the project already has a
 * ProjectReference, the new one is appended next to it (sharing its indentation and ItemGroup);
 * otherwise a fresh `<ItemGroup>` is inserted just before `</Project>`.
 */
export function addProjectReference(csprojText: string, includePath: string): string {
  const newline = detectNewline(csprojText);
  const lines = csprojText.split(/\r\n|\n/);

  let lastRefIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PROJECT_REFERENCE_LINE_PATTERN.test(lines[i])) {
      lastRefIndex = i;
    }
  }

  if (lastRefIndex !== -1) {
    lines.splice(lastRefIndex + 1, 0, projectReferenceLine(leadingIndent(lines[lastRefIndex]), includePath));
    return lines.join(newline);
  }

  const closeIndex = lines.findIndex((line) => line.includes("</Project>"));
  if (closeIndex === -1) {
    return csprojText;
  }
  const indent = `${leadingIndent(lines[closeIndex])}  `;
  lines.splice(
    closeIndex,
    0,
    `${indent}<ItemGroup>`,
    projectReferenceLine(`${indent}  `, includePath),
    `${indent}</ItemGroup>`,
  );
  return lines.join(newline);
}

/**
 * Removes the `<ProjectReference>` whose `Include` resolves to `includePath` (compared
 * slash-insensitively and case-insensitively), then drops any `<ItemGroup>` left empty by it.
 */
export function removeProjectReference(csprojText: string, includePath: string): string {
  const newline = detectNewline(csprojText);
  const lines = csprojText.split(/\r\n|\n/);
  const target = normalizePath(includePath);

  const kept = lines.filter((line) => {
    if (!PROJECT_REFERENCE_LINE_PATTERN.test(line)) {
      return true;
    }
    const include = INCLUDE_ATTR_PATTERN.exec(line)?.[1];
    return !include || normalizePath(include) !== target;
  });

  return removeEmptyItemGroups(kept, newline);
}

/** Drops `<ItemGroup>…</ItemGroup>` pairs whose body is now only whitespace. */
function removeEmptyItemGroups(lines: string[], newline: string): string {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ITEM_GROUP_OPEN_PATTERN.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        j++;
      }
      if (j < lines.length && lines[j].trim() === "</ItemGroup>") {
        i = j; // Skip the open line, the blank lines, and the close line.
        continue;
      }
    }
    result.push(lines[i]);
  }
  return result.join(newline);
}

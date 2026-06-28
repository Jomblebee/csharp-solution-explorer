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

/**
 * Adds a new `Project(...)` ... `EndProject` block for a project or solution folder.
 * Inserts it before the first `Global` section (or at the end if no Global section exists).
 */
export function addProjectEntry(
  slnText: string,
  typeGuid: string,
  name: string,
  relativePath: string,
  projectGuid: string,
): string {
  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const globalIndex = slnText.search(/^\s*Global\s*$/m);

  const projectBlock = `Project("${typeGuid}") = "${name}", "${relativePath}", "${projectGuid}"${newline}EndProject`;

  if (globalIndex === -1) {
    return slnText + newline + projectBlock;
  }

  return slnText.slice(0, globalIndex) + projectBlock + newline + newline + slnText.slice(globalIndex);
}

/**
 * Adds a nesting relation `{childGuid} = {parentGuid}` to the `GlobalSection(NestedProjects)` block.
 * Creates the section if it doesn't exist.
 */
export function addNestedProjectRelation(slnText: string, childGuid: string, parentGuid: string): string {
  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const nestedProjectsPattern = /GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i;
  const match = nestedProjectsPattern.exec(slnText);

  if (match) {
    const endGlobalSectionLine = slnText.indexOf("EndGlobalSection", match.index);

    const newRelation = `${newline}\t${childGuid} = ${parentGuid}`;
    return slnText.slice(0, endGlobalSectionLine) + newRelation + newline + slnText.slice(endGlobalSectionLine);
  }

  const globalPattern = /^Global\s*$/m;
  const globalMatch = globalPattern.exec(slnText);
  if (globalMatch) {
    const globalIndex = globalMatch.index;
    const nestedProjectsSection =
      `GlobalSection(NestedProjects) = preSolution${newline}` +
      `\t${childGuid} = ${parentGuid}${newline}` +
      `EndGlobalSection`;

    return slnText.slice(0, globalIndex) + nestedProjectsSection + newline + newline + slnText.slice(globalIndex);
  }

  throw new Error("Could not find Global section in solution file");
}

/**
 * Adds `ActiveCfg` and `Build.0` entries for the given project GUID to
 * `GlobalSection(ProjectConfigurationPlatforms) = postSolution`, one pair per configuration
 * (e.g. `Debug|Any CPU`). Creates the section before the closing `EndGlobal` if it doesn't exist.
 */
export function addProjectConfigurationPlatforms(
  slnText: string,
  projectGuid: string,
  configs: string[],
): string {
  if (configs.length === 0) {
    return slnText;
  }

  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const entryLines = configs.flatMap((cfg) => [
    `\t\t${projectGuid}.${cfg}.ActiveCfg = ${cfg}`,
    `\t\t${projectGuid}.${cfg}.Build.0 = ${cfg}`,
  ]);

  const sectionPattern =
    /GlobalSection\(ProjectConfigurationPlatforms\)\s*=\s*postSolution([\s\S]*?)EndGlobalSection/i;
  const match = sectionPattern.exec(slnText);

  if (match) {
    const endGlobalSectionLine = slnText.indexOf("EndGlobalSection", match.index);
    const insertion = entryLines.join(newline) + newline;
    return slnText.slice(0, endGlobalSectionLine) + insertion + slnText.slice(endGlobalSectionLine);
  }

  const endGlobalPattern = /^\s*EndGlobal\s*$/m;
  const endGlobalMatch = endGlobalPattern.exec(slnText);
  if (!endGlobalMatch) {
    throw new Error("Could not find EndGlobal section in solution file");
  }

  const section =
    `\tGlobalSection(ProjectConfigurationPlatforms) = postSolution${newline}` +
    entryLines.join(newline) +
    `${newline}\tEndGlobalSection${newline}`;
  return slnText.slice(0, endGlobalMatch.index) + section + slnText.slice(endGlobalMatch.index);
}

/**
 * Removes the nesting relation for the given child GUID from `GlobalSection(NestedProjects)`.
 * Does nothing if the child is not nested or if the section doesn't exist.
 */
export function removeNestedProjectRelation(slnText: string, childGuid: string): string {
  const newline = slnText.includes("\r\n") ? "\r\n" : "\n";
  const nestedProjectsPattern = /GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/i;
  const match = nestedProjectsPattern.exec(slnText);

  if (!match) {
    return slnText;
  }

  const lines = slnText.split(/\r\n|\n/);
  const updated = lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(`${childGuid} =`);
  });

  return updated.join(newline);
}

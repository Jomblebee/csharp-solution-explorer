/**
 * Builds the namespace for a new file placed under `targetDirPath`, following the
 * project's convention of mirroring folder structure (e.g. a class in
 * `<projectRoot>/Models` of project `App` gets namespace `App.Models`).
 */
export function buildNamespace(projectName: string, projectRootDirPath: string, targetDirPath: string): string {
  const rootPath = projectRootDirPath.replace(/[/\\]+$/, "");
  const targetPath = targetDirPath.replace(/[/\\]+$/, "");

  const relative = targetPath.startsWith(rootPath) ? targetPath.slice(rootPath.length) : "";
  const segments = relative.split(/[/\\]/).filter(Boolean);

  return [projectName, ...segments].join(".");
}

export function buildClassFileContent(namespace: string, className: string): string {
  return `namespace ${namespace};\n\npublic class ${className}\n{\n}\n`;
}

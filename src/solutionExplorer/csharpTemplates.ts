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

export const DEFAULT_CLASS_TEMPLATE = "namespace ${namespace};\n\npublic class ${name}\n{\n    ${cursor}\n}\n";
export const DEFAULT_INTERFACE_TEMPLATE = "namespace ${namespace};\n\npublic interface ${name}\n{\n    ${cursor}\n}\n";
export const DEFAULT_RECORD_TEMPLATE = "namespace ${namespace};\n\npublic record ${name}(${cursor});\n";
export const DEFAULT_ENUM_TEMPLATE = "namespace ${namespace};\n\npublic enum ${name}\n{\n    ${cursor}\n}\n";
export const DEFAULT_STRUCT_TEMPLATE = "namespace ${namespace};\n\npublic struct ${name}\n{\n    ${cursor}\n}\n";

export function applyTemplate(
  template: string,
  namespace: string,
  name: string,
  filename: string,
  date: string,
): string {
  return template
    .replace(/\$\{namespace\}/g, namespace)
    .replace(/\$\{name\}/g, name)
    .replace(/\$\{filename\}/g, filename)
    .replace(/\$\{date\}/g, date);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function applyCursorTemplate(
  template: string,
  namespace: string,
  name: string,
  filename: string,
  date: string,
): { content: string; cursorOffset: number | undefined } {
  const applied = applyTemplate(template, namespace, name, filename, date);
  const idx = applied.indexOf("${cursor}");
  if (idx === -1) return { content: applied, cursorOffset: undefined };
  return {
    content: applied.slice(0, idx) + applied.slice(idx + "${cursor}".length),
    cursorOffset: idx,
  };
}

export function buildClassFileContent(
  namespace: string,
  className: string,
  template = DEFAULT_CLASS_TEMPLATE,
): string {
  return applyTemplate(template, namespace, className, `${className}.cs`, today());
}

export function buildInterfaceFileContent(
  namespace: string,
  interfaceName: string,
  template = DEFAULT_INTERFACE_TEMPLATE,
): string {
  return applyTemplate(template, namespace, interfaceName, `${interfaceName}.cs`, today());
}

export function generateRecord(namespace: string, name: string, template = DEFAULT_RECORD_TEMPLATE, ext = ".cs"): string {
  return applyTemplate(template, namespace, name, `${name}${ext}`, today());
}

export function generateEnum(namespace: string, name: string, template = DEFAULT_ENUM_TEMPLATE, ext = ".cs"): string {
  return applyTemplate(template, namespace, name, `${name}${ext}`, today());
}

export function generateStruct(namespace: string, name: string, template = DEFAULT_STRUCT_TEMPLATE, ext = ".cs"): string {
  return applyTemplate(template, namespace, name, `${name}${ext}`, today());
}

export const DEFAULT_RAZOR_TEMPLATE = "@namespace ${namespace}\n\n<h3>${name}</h3>\n\n@code {\n    ${cursor}\n}\n";

export function generateRazor(namespace: string, name: string, template = DEFAULT_RAZOR_TEMPLATE, ext = ".razor"): string {
  return applyTemplate(template, namespace, name, `${name}${ext}`, today());
}

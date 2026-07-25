import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyCursorTemplate, buildNamespace } from "./csharpTemplates.js";
import { basenameWithoutExtension, SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import { FolderTreeItem, ProjectTreeItem, SolutionFolderTreeItem } from "./treeItems.js";
import { isNewItemTarget, NewItemTarget, validateNewName } from "./commandUtils.js";

function getTargetDirUri(item: NewItemTarget): vscode.Uri {
  if (item instanceof FolderTreeItem) {
    return item.entry.uri;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.solutionDir;
  }
  return item.info.rootDir;
}

function validateNewCsharpName(value: string, dirPath: string, suffix: string): string | undefined {
  if (!value.trim()) {
    return "Name must not be empty";
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    return "Must be a valid C# identifier: start with a letter or underscore, then letters, digits, or underscores only";
  }
  if (fs.existsSync(path.join(dirPath, `${value}${suffix}`))) {
    return "A file or folder with that name already exists";
  }
  return undefined;
}

function resolveTemplate(key: string): string | undefined {
  const setting = vscode.workspace.getConfiguration("csharpSolutionExplorer").get<string>(key) ?? "";
  if (!setting.trim()) { return undefined; }
  return setting;
}

interface NewCsharpFileOptions {
  templateKey: string;
  typeName: string;
  prompt: string;
  placeholder: string;
  extension: ".cs" | ".razor";
  initialValue?: string;
  requiresUppercase?: boolean;
}

async function createNewCsharpFile(
  item: unknown,
  provider: SolutionTreeDataProvider,
  opts: NewCsharpFileOptions,
): Promise<void> {
  if (!isNewItemTarget(item)) {
    return;
  }

  const template = resolveTemplate(opts.templateKey);
  if (!template) {
    vscode.window.showErrorMessage(
      `C# Solution Explorer: The ${opts.typeName} template setting is empty. Restore the default by clicking the reset icon in Settings.`,
    );
    return;
  }

  const targetDirUri = getTargetDirUri(item);
  const name = await vscode.window.showInputBox({
    prompt: opts.prompt,
    placeHolder: opts.placeholder,
    value: opts.initialValue,
    valueSelection: opts.initialValue !== undefined ? [opts.initialValue.length, opts.initialValue.length] : undefined,
    validateInput: (value) => {
      const baseError = validateNewCsharpName(value, targetDirUri.fsPath, opts.extension);
      if (baseError) {
        return baseError;
      }
      if (opts.requiresUppercase && value && !/^[A-Z]/.test(value)) {
        return "Razor component names must start with an uppercase letter (Blazor convention)";
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }

  let projectName: string;
  let projectRootDirPath: string;
  if (item instanceof ProjectTreeItem) {
    projectName = item.info.name;
    projectRootDirPath = item.info.rootDir.fsPath;
  } else {
    const csprojPath = findContainingCsprojPath(targetDirUri.fsPath);
    projectName = csprojPath ? basenameWithoutExtension(csprojPath) : name;
    projectRootDirPath = csprojPath ? path.dirname(csprojPath) : targetDirUri.fsPath;
  }

  const namespace = buildNamespace(projectName, projectRootDirPath, targetDirUri.fsPath);
  const date = new Date().toISOString().slice(0, 10);
  const { content, cursorOffset } = applyCursorTemplate(template, namespace, name, `${name}${opts.extension}`, date);
  const fileUri = vscode.Uri.joinPath(targetDirUri, `${name}${opts.extension}`);

  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
  provider.refresh();
  const editor = await vscode.window.showTextDocument(fileUri);
  if (cursorOffset !== undefined) {
    const pos = editor.document.positionAt(cursorOffset);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
  }
}

/** Walks up from `startDirPath` to find the nearest containing .csproj file. */
function findContainingCsprojPath(startDirPath: string): string | undefined {
  let dir = startDirPath;
  while (true) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const csprojName = entries.find(
      (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".csproj",
    )?.name;
    if (csprojName) {
      return path.join(dir, csprojName);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function newClass(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.class",
    typeName: "class",
    prompt: "Class name",
    placeholder: "MyClass",
    extension: ".cs",
  });
}

export function newInterface(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.interface",
    typeName: "interface",
    prompt: "Interface name",
    placeholder: "IMyService",
    extension: ".cs",
    initialValue: "I",
  });
}

export function newRecord(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.record",
    typeName: "record",
    prompt: "Record name",
    placeholder: "MyRecord",
    extension: ".cs",
  });
}

export function newEnum(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.enum",
    typeName: "enum",
    prompt: "Enum name",
    placeholder: "MyEnum",
    extension: ".cs",
  });
}

export function newStruct(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.struct",
    typeName: "struct",
    prompt: "Struct name",
    placeholder: "MyStruct",
    extension: ".cs",
  });
}

export function newRazor(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.razor",
    typeName: "Razor component",
    prompt: "Component name",
    placeholder: "MyComponent",
    extension: ".razor",
    requiresUppercase: true,
  });
}

export async function newFile(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isNewItemTarget(item)) {
    return;
  }

  const targetDirUri = getTargetDirUri(item);
  const filename = await vscode.window.showInputBox({
    prompt: "File name (with extension)",
    placeHolder: "e.g. appsettings.json",
    validateInput: (value) => validateNewName(value, targetDirUri.fsPath),
  });
  if (!filename) {
    return;
  }

  const fileUri = vscode.Uri.joinPath(targetDirUri, filename);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(""));
  provider.refresh();
  const editor = await vscode.window.showTextDocument(fileUri);
  const pos = editor.document.positionAt(0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

export async function newFolder(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isNewItemTarget(item)) {
    return;
  }

  const targetDirUri = getTargetDirUri(item);
  const folderName = await vscode.window.showInputBox({
    prompt: "Folder name",
    validateInput: (value) => validateNewName(value, targetDirUri.fsPath),
  });
  if (!folderName) {
    return;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetDirUri, folderName));
  provider.refresh();
}

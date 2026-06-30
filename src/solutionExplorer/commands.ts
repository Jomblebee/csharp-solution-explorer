import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  applyCursorTemplate,
  buildNamespace,
} from "./csharpTemplates.js";
import { basenameWithoutExtension, SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import { parseProjectReferences } from "./csprojReader.js";
import {
  CSHARP_PROJECT_TYPE_GUID,
  parseSolutionConfigurations,
  parseSolutionFile,
  SOLUTION_FOLDER_TYPE_GUID,
  SolutionTreeNode,
} from "./slnParser.js";
import {
  addNestedProjectRelation,
  addProjectConfigurationPlatforms,
  addProjectEntry,
  removeProjectEntry,
  renameProjectEntry,
} from "./slnWriter.js";
import {
  addSlnxFolderEntry,
  addSlnxProjectEntry,
  removeSlnxFolderEntry,
  removeSlnxProjectEntry,
  renameSlnxFolderEntry,
  renameSlnxProjectEntry,
} from "./slnxWriter.js";
import { parseSlnxFile } from "./slnxParser.js";
import {
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  FileTreeItem,
  FolderTreeItem,
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  ProjectTreeItem,
  SolutionFolderTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";
import { addProjectReference as addProjectReferenceToCsproj, removeProjectReference as removeProjectReferenceFromCsproj } from "./csprojWriter.js";
import { addPackage, removePackage, restore } from "./dotnetCli.js";
import { getPackageVersions, NugetPackage, searchPackages } from "../nuget/nugetApi.js";
import {
  BUILD_PROJECT_COMMAND_ID,
  DELETE_COMMAND_ID,
  NEW_CLASS_COMMAND_ID,
  NEW_FOLDER_COMMAND_ID,
  NEW_INTERFACE_COMMAND_ID,
  NEW_RECORD_COMMAND_ID,
  NEW_ENUM_COMMAND_ID,
  NEW_STRUCT_COMMAND_ID,
  NEW_RAZOR_COMMAND_ID,
  NEW_FILE_COMMAND_ID,
  NEW_SOLUTION_FOLDER_COMMAND_ID,
  OPEN_FILE_COMMAND_ID,
  OPEN_SETTINGS_COMMAND_ID,
  OPEN_SOLUTION_FILE_COMMAND_ID,
  ProjectInfo,
  REFRESH_COMMAND_ID,
  RENAME_COMMAND_ID,
  RUN_PROJECT_COMMAND_ID,
  ADD_EXISTING_PROJECT_COMMAND_ID,
  REMOVE_PROJECT_FROM_SOLUTION_COMMAND_ID,
  ADD_PROJECT_REFERENCE_COMMAND_ID,
  REMOVE_PROJECT_REFERENCE_COMMAND_ID,
  ADD_PACKAGE_REFERENCE_COMMAND_ID,
  REMOVE_PACKAGE_REFERENCE_COMMAND_ID,
  UPDATE_PACKAGE_REFERENCE_COMMAND_ID,
  SolutionFolderInfo,
} from "./types.js";

type NewItemTarget = FolderTreeItem | ProjectTreeItem | SolutionFolderTreeItem;
type ExistingItemTarget = FolderTreeItem | FileTreeItem | ProjectTreeItem | SolutionFolderTreeItem;

export function registerSolutionExplorerCommands(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND_ID, () => provider.refresh()),
    vscode.commands.registerCommand(OPEN_FILE_COMMAND_ID, (uri: vscode.Uri) =>
      vscode.window.showTextDocument(uri),
    ),
    vscode.commands.registerCommand(NEW_CLASS_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newClass(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_INTERFACE_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newInterface(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_RECORD_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newRecord(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_ENUM_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newEnum(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_STRUCT_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newStruct(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_RAZOR_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newRazor(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_FILE_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newFile(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_FOLDER_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newFolder(item, provider)),
    ),
    vscode.commands.registerCommand(NEW_SOLUTION_FOLDER_COMMAND_ID, (item: NewItemTarget) =>
      withErrorHandling(() => newSolutionFolder(item, provider)),
    ),
    vscode.commands.registerCommand(RENAME_COMMAND_ID, (item: ExistingItemTarget) =>
      withErrorHandling(() => rename(item, provider)),
    ),
    vscode.commands.registerCommand(DELETE_COMMAND_ID, (item: ExistingItemTarget) =>
      withErrorHandling(() => deleteItem(item, provider)),
    ),
    vscode.commands.registerCommand(ADD_EXISTING_PROJECT_COMMAND_ID, (item: unknown) =>
      withErrorHandling(() => addExistingProject(item, provider)),
    ),
    vscode.commands.registerCommand(REMOVE_PROJECT_FROM_SOLUTION_COMMAND_ID, (item: ProjectTreeItem) =>
      withErrorHandling(() => removeProjectFromSolution(item, provider)),
    ),
    vscode.commands.registerCommand(ADD_PROJECT_REFERENCE_COMMAND_ID, (item: unknown) =>
      withErrorHandling(() => addProjectReference(item, provider)),
    ),
    vscode.commands.registerCommand(REMOVE_PROJECT_REFERENCE_COMMAND_ID, (item: ProjectReferenceTreeItem) =>
      withErrorHandling(() => removeProjectReference(item, provider)),
    ),
    vscode.commands.registerCommand(ADD_PACKAGE_REFERENCE_COMMAND_ID, (item: unknown) =>
      withErrorHandling(() => addPackageReference(item, provider)),
    ),
    vscode.commands.registerCommand(REMOVE_PACKAGE_REFERENCE_COMMAND_ID, (item: PackageReferenceTreeItem) =>
      withErrorHandling(() => removePackageReference(item, provider)),
    ),
    vscode.commands.registerCommand(UPDATE_PACKAGE_REFERENCE_COMMAND_ID, (item: PackageReferenceTreeItem) =>
      withErrorHandling(() => updatePackageReference(item, provider)),
    ),
    vscode.commands.registerCommand(BUILD_PROJECT_COMMAND_ID, (item: ProjectTreeItem) => buildProject(item)),
    vscode.commands.registerCommand(RUN_PROJECT_COMMAND_ID, (item: ProjectTreeItem) => runProject(item)),
    vscode.commands.registerCommand(OPEN_SOLUTION_FILE_COMMAND_ID, (item: SolutionTreeItem) =>
      vscode.window.showTextDocument(item.info.uri),
    ),
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND_ID, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:jomblebee.jomblebee-csharp-solution-explorer"),
    ),
  );
}

async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    vscode.window.showErrorMessage(`C# Solution Explorer: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNewItemTarget(item: unknown): item is NewItemTarget {
  return item instanceof FolderTreeItem || item instanceof ProjectTreeItem || item instanceof SolutionFolderTreeItem;
}

function isExistingItemTarget(item: unknown): item is ExistingItemTarget {
  return (
    item instanceof FolderTreeItem ||
    item instanceof FileTreeItem ||
    item instanceof ProjectTreeItem ||
    item instanceof SolutionFolderTreeItem
  );
}

function getTargetDirUri(item: NewItemTarget): vscode.Uri {
  if (item instanceof FolderTreeItem) {
    return item.entry.uri;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.solutionDir;
  }
  return item.info.rootDir;
}

function getEntryUri(item: ExistingItemTarget): vscode.Uri {
  if (item instanceof ProjectTreeItem) {
    return item.info.uri;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.solutionUri;
  }
  return item.entry.uri;
}

function getDisplayName(item: ExistingItemTarget): string {
  if (item instanceof ProjectTreeItem) {
    return item.info.name;
  }
  if (item instanceof SolutionFolderTreeItem) {
    return item.info.name;
  }
  return item.entry.name;
}

function validateNewName(value: string, dirPath: string, suffix = ""): string | undefined {
  if (!value.trim()) {
    return "Name must not be empty";
  }
  if (/[\\/]/.test(value)) {
    return "Name must not contain path separators";
  }
  if (fs.existsSync(path.join(dirPath, `${value}${suffix}`))) {
    return "A file or folder with that name already exists";
  }
  return undefined;
}

function validateNewCsharpName(value: string, dirPath: string, suffix: string): string | undefined {
  if (!value.trim()) return "Name must not be empty";
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
  if (!isNewItemTarget(item)) return;

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
      if (baseError) return baseError;
      if (opts.requiresUppercase && value && !/^[A-Z]/.test(value)) {
        return "Razor component names must start with an uppercase letter (Blazor convention)";
      }
      return undefined;
    },
  });
  if (!name) return;

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

function toPosixRelative(fromDirPath: string, toPath: string): string {
  return path.relative(fromDirPath, toPath).split(path.sep).join("/");
}

function newClass(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.class",
    typeName: "class",
    prompt: "Class name",
    placeholder: "MyClass",
    extension: ".cs",
  });
}

function newInterface(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.interface",
    typeName: "interface",
    prompt: "Interface name",
    placeholder: "IMyService",
    extension: ".cs",
    initialValue: "I",
  });
}

function newRecord(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.record",
    typeName: "record",
    prompt: "Record name",
    placeholder: "MyRecord",
    extension: ".cs",
  });
}

function newEnum(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.enum",
    typeName: "enum",
    prompt: "Enum name",
    placeholder: "MyEnum",
    extension: ".cs",
  });
}

function newStruct(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.struct",
    typeName: "struct",
    prompt: "Struct name",
    placeholder: "MyStruct",
    extension: ".cs",
  });
}

function newRazor(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  return createNewCsharpFile(item, provider, {
    templateKey: "templates.razor",
    typeName: "Razor component",
    prompt: "Component name",
    placeholder: "MyComponent",
    extension: ".razor",
    requiresUppercase: true,
  });
}

async function newFile(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isNewItemTarget(item)) return;

  const targetDirUri = getTargetDirUri(item);
  const filename = await vscode.window.showInputBox({
    prompt: "File name (with extension)",
    placeHolder: "e.g. appsettings.json",
    validateInput: (value) => validateNewName(value, targetDirUri.fsPath),
  });
  if (!filename) return;

  const fileUri = vscode.Uri.joinPath(targetDirUri, filename);
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(""));
  provider.refresh();
  const editor = await vscode.window.showTextDocument(fileUri);
  const pos = editor.document.positionAt(0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

async function newFolder(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
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

async function rename(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isExistingItemTarget(item)) {
    return;
  }

  const currentName = getDisplayName(item);
  const newName = await vscode.window.showInputBox({ prompt: "New name", value: currentName });
  if (!newName || newName === currentName) {
    return;
  }

  if (item instanceof ProjectTreeItem) {
    await renameProject(item.info, newName);
  } else if (item instanceof SolutionFolderTreeItem) {
    await renameSolutionFolder(item.info, newName);
  } else {
    const oldUri = getEntryUri(item);
    const finalName =
      item instanceof FileTreeItem && !newName.includes(".")
        ? `${newName}${path.extname(currentName)}`
        : newName;
    const newUri = vscode.Uri.joinPath(oldUri, "..", finalName);
    await vscode.workspace.fs.rename(oldUri, newUri);
  }

  provider.refresh();
}

async function renameSolutionFolder(info: SolutionFolderInfo, newName: string): Promise<void> {
  if (!info.guid) {
    throw new Error("Solution folder GUID is missing");
  }

  const slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));
  const isSlnx = info.solutionUri.fsPath.toLowerCase().endsWith(".slnx");
  const newSlnText = isSlnx
    ? renameSlnxFolderEntry(slnText, info.guid, newName)
    : renameProjectEntry(slnText, info.guid, newName, newName);
  await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
}

async function deleteSolutionFolder(info: SolutionFolderInfo): Promise<void> {
  if (!info.guid) {
    throw new Error("Solution folder GUID is missing");
  }

  let slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));

  if (info.solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
    const newSlnText = removeSlnxFolderEntry(slnText, info.guid);
    await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    return;
  }

  function collectDescendantGuids(node: SolutionTreeNode, guids: Set<string>): void {
    if (node.kind === "solutionFolder") {
      guids.add(node.guid);
      for (const child of node.children) {
        collectDescendantGuids(child, guids);
      }
    } else {
      guids.add(node.guid);
    }
  }

  const descendantGuids = new Set<string>();
  for (const child of info.children) {
    collectDescendantGuids(child, descendantGuids);
  }

  for (const guid of descendantGuids) {
    slnText = removeProjectEntry(slnText, guid);
  }
  slnText = removeProjectEntry(slnText, info.guid);

  await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(slnText));
}

async function newSolutionFolder(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  let solutionUri: vscode.Uri | undefined;
  let parentFolderGuid: string | undefined;
  if (item instanceof SolutionTreeItem) {
    solutionUri = item.info.uri;
  } else if (item instanceof SolutionFolderTreeItem) {
    solutionUri = item.info.solutionUri;
    parentFolderGuid = item.info.guid;
  } else {
    return;
  }

  if (!solutionUri) {
    throw new Error("Solution file not found");
  }

  const folderName = await vscode.window.showInputBox({
    prompt: "Solution Folder name",
    validateInput: (value) => {
      if (!value.trim()) {
        return "Name must not be empty";
      }
      return undefined;
    },
  });

  if (!folderName) {
    return;
  }

  const name = folderName.trim();
  const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));
  let updated: string;
  if (solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
    // For .slnx, solution folders are identified by name; parentFolderGuid carries the parent's name.
    updated = addSlnxFolderEntry(original, name, parentFolderGuid);
  } else {
    const newGuid = generateSlnGuid();
    updated = addProjectEntry(original, SOLUTION_FOLDER_TYPE_GUID, name, name, newGuid);
    if (parentFolderGuid) {
      updated = addNestedProjectRelation(updated, newGuid, parentFolderGuid);
    }
  }

  await vscode.workspace.fs.writeFile(solutionUri, new TextEncoder().encode(updated));
  provider.refresh();
}

async function addExistingProject(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  let solutionUri: vscode.Uri | undefined;
  // For .sln this is the parent solution folder's GUID; for .slnx it is the parent folder's name.
  let parentFolder: string | undefined;
  if (item instanceof SolutionTreeItem) {
    solutionUri = item.info.uri;
  } else if (item instanceof SolutionFolderTreeItem) {
    solutionUri = item.info.solutionUri;
    parentFolder = item.info.guid;
  } else {
    return;
  }

  if (!solutionUri) {
    throw new Error("Solution file not found");
  }

  const selection = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Add Project",
    filters: { "Project Files": ["csproj", "fsproj", "vbproj"] },
  });
  if (!selection || selection.length === 0) {
    return;
  }
  const csprojUri = selection[0];

  const solutionDir = vscode.Uri.joinPath(solutionUri, "..");
  const relativePath = toPosixRelative(solutionDir.fsPath, csprojUri.fsPath);
  const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));
  const isSlnx = solutionUri.fsPath.toLowerCase().endsWith(".slnx");

  const existingPaths = isSlnx
    ? collectSlnxProjectPaths(parseSlnxFile(original))
    : parseSolutionFile(original).map((ref) => ref.relativePath);
  if (existingPaths.some((p) => p.toLowerCase() === relativePath.toLowerCase())) {
    vscode.window.showWarningMessage(`'${relativePath}' is already part of this solution.`);
    return;
  }

  let updated: string;
  if (isSlnx) {
    updated = addSlnxProjectEntry(original, relativePath, parentFolder);
  } else {
    const name = basenameWithoutExtension(csprojUri.fsPath);
    const guid = generateSlnGuid();
    updated = addProjectEntry(original, CSHARP_PROJECT_TYPE_GUID, name, relativePath, guid);
    updated = addProjectConfigurationPlatforms(updated, guid, parseSolutionConfigurations(original));
    if (parentFolder) {
      updated = addNestedProjectRelation(updated, guid, parentFolder);
    }
  }

  await vscode.workspace.fs.writeFile(solutionUri, new TextEncoder().encode(updated));
  provider.refresh();
}

function collectSlnxProjectPaths(nodes: SolutionTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "project") {
      paths.push(node.relativePath);
    } else {
      paths.push(...collectSlnxProjectPaths(node.children));
    }
  }
  return paths;
}

async function removeProjectFromSolution(item: ProjectTreeItem, provider: SolutionTreeDataProvider): Promise<void> {
  if (!item.info.solutionUri) {
    throw new Error("Project is not part of a solution");
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Remove '${item.info.name}' from the solution? The project files will be kept on disk.`,
    { modal: true },
    "Remove",
  );
  if (confirmation !== "Remove") {
    return;
  }

  const solutionUri = item.info.solutionUri;
  const solutionDir = vscode.Uri.joinPath(solutionUri, "..");
  const relativePath = toPosixRelative(solutionDir.fsPath, item.info.uri.fsPath);
  const slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));

  let newSlnText: string;
  if (solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
    newSlnText = removeSlnxProjectEntry(slnText, relativePath);
  } else {
    const guid =
      item.info.guid ??
      parseSolutionFile(slnText).find((ref) => ref.relativePath.toLowerCase() === relativePath.toLowerCase())
        ?.projectGuid;
    if (!guid) {
      return;
    }
    newSlnText = removeProjectEntry(slnText, guid);
  }

  await vscode.workspace.fs.writeFile(solutionUri, new TextEncoder().encode(newSlnText));
  provider.refresh();
}

/** The .csproj that should receive a new `<ProjectReference>`, derived from the right-clicked node. */
function resolveOwningProjectUri(item: unknown): vscode.Uri | undefined {
  if (item instanceof ProjectTreeItem) {
    return item.info.uri;
  }
  if (item instanceof DependenciesTreeItem) {
    return item.project.uri;
  }
  if (item instanceof DependencyCategoryTreeItem) {
    return item.info.dependencies.projectUri;
  }
  return undefined;
}

async function addProjectReference(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  const ownerUri = resolveOwningProjectUri(item);
  if (!ownerUri) {
    return;
  }
  const ownerDir = path.dirname(ownerUri.fsPath);
  const ownerText = new TextDecoder().decode(await vscode.workspace.fs.readFile(ownerUri));
  const alreadyReferenced = new Set(
    parseProjectReferences(ownerText).map((ref) => path.resolve(ownerDir, ref.relativePath).toLowerCase()),
  );

  const candidateUris = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/{bin,obj,node_modules,.git,.vs}/**",
  );
  const candidates = candidateUris
    .filter((uri) => uri.fsPath.toLowerCase() !== ownerUri.fsPath.toLowerCase())
    .filter((uri) => !alreadyReferenced.has(uri.fsPath.toLowerCase()))
    .sort((a, b) => basenameWithoutExtension(a.fsPath).localeCompare(basenameWithoutExtension(b.fsPath)));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage("No other projects are available to reference.");
    return;
  }

  const picks = await vscode.window.showQuickPick(
    candidates.map((uri) => ({
      label: basenameWithoutExtension(uri.fsPath),
      description: toPosixRelative(ownerDir, uri.fsPath),
      uri,
    })),
    { canPickMany: true, placeHolder: "Select projects to reference" },
  );
  if (!picks || picks.length === 0) {
    return;
  }

  let updated = ownerText;
  for (const pick of picks) {
    // Write the include in Windows-style backslash form, matching Visual Studio and the samples.
    const includePath = path.relative(ownerDir, pick.uri.fsPath).split(path.sep).join("\\");
    updated = addProjectReferenceToCsproj(updated, includePath);
  }

  await vscode.workspace.fs.writeFile(ownerUri, new TextEncoder().encode(updated));
  provider.refresh();
}

async function removeProjectReference(item: ProjectReferenceTreeItem, provider: SolutionTreeDataProvider): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Remove the reference to '${item.info.name}'? The referenced project's files are kept on disk.`,
    { modal: true },
    "Remove",
  );
  if (confirmation !== "Remove") {
    return;
  }

  const ownerUri = item.info.ownerUri;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(ownerUri));
  const updated = removeProjectReferenceFromCsproj(text, item.info.includePath);

  await vscode.workspace.fs.writeFile(ownerUri, new TextEncoder().encode(updated));
  provider.refresh();
}

interface PackagePickItem extends vscode.QuickPickItem {
  id: string;
}

/** Debounces a void-returning function so rapid calls (e.g. keystrokes) collapse into the last one. */
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatPackageDetail(pkg: NugetPackage): string {
  const downloads = pkg.totalDownloads > 0 ? `${formatDownloads(pkg.totalDownloads)} downloads` : "";
  return [downloads, pkg.description].filter(Boolean).join(" · ");
}

/** Opens a QuickPick that searches nuget.org as the user types; resolves to the chosen package id. */
function pickPackageFromSearch(): Promise<string | undefined> {
  const quickPick = vscode.window.createQuickPick<PackagePickItem>();
  quickPick.placeholder = "Search nuget.org for a package";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  // Monotonic token so a slow earlier search can't overwrite the results of a newer one.
  let latest = 0;
  const runSearch = debounce(async (value: string) => {
    const term = value.trim();
    if (!term) {
      quickPick.items = [];
      quickPick.busy = false;
      return;
    }
    const token = ++latest;
    quickPick.busy = true;
    try {
      const results = await searchPackages(term);
      if (token !== latest) {
        return;
      }
      quickPick.title = undefined;
      quickPick.items = results.map((pkg) => ({
        label: pkg.verified ? `$(verified) ${pkg.id}` : pkg.id,
        id: pkg.id,
        description: pkg.version,
        detail: formatPackageDetail(pkg),
      }));
    } catch (err) {
      if (token === latest) {
        quickPick.items = [];
        quickPick.title = `Search failed: ${errorMessage(err)}`;
      }
    } finally {
      if (token === latest) {
        quickPick.busy = false;
      }
    }
  }, 300);

  return new Promise<string | undefined>((resolve) => {
    quickPick.onDidChangeValue((value) => runSearch(value));
    quickPick.onDidAccept(() => {
      const id = quickPick.selectedItems[0]?.id;
      resolve(id);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(undefined);
    });
    quickPick.show();
  });
}

/** Loads a package's versions from nuget.org and lets the user pick one (newest first). */
async function pickPackageVersion(id: string, currentVersion?: string): Promise<string | undefined> {
  const versions = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading versions for ${id}…` },
    () => getPackageVersions(id),
  );
  if (versions.length === 0) {
    vscode.window.showWarningMessage(`No versions were found for '${id}' on nuget.org.`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    versions.map((version) => ({
      label: version,
      description: version === currentVersion ? "current" : undefined,
    })),
    { placeHolder: `Select a version of ${id}` },
  );
  return picked?.label;
}

function installPackage(projectUri: vscode.Uri, id: string, version: string, title: string): Thenable<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => addPackage(projectUri.fsPath, id, version),
  );
}

async function addPackageReference(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  const ownerUri = resolveOwningProjectUri(item);
  if (!ownerUri) {
    return;
  }
  const id = await pickPackageFromSearch();
  if (!id) {
    return;
  }
  const version = await pickPackageVersion(id);
  if (!version) {
    return;
  }
  await installPackage(ownerUri, id, version, `Installing ${id} ${version}…`);
  provider.refresh();
}

async function removePackageReference(item: PackageReferenceTreeItem, provider: SolutionTreeDataProvider): Promise<void> {
  const projectUri = item.info.projectUri;
  if (!projectUri) {
    return;
  }
  const confirmation = await vscode.window.showWarningMessage(
    `Remove the package '${item.info.name}' from the project?`,
    { modal: true },
    "Remove",
  );
  if (confirmation !== "Remove") {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Removing ${item.info.name}…` },
    async () => {
      await removePackage(projectUri.fsPath, item.info.name);
      // `dotnet remove package` doesn't restore, so refresh project.assets.json ourselves.
      await restore(projectUri.fsPath);
    },
  );
  provider.refresh();
}

async function updatePackageReference(item: PackageReferenceTreeItem, provider: SolutionTreeDataProvider): Promise<void> {
  const projectUri = item.info.projectUri;
  if (!projectUri) {
    return;
  }
  const version = await pickPackageVersion(item.info.name, item.info.version);
  if (!version || version === item.info.version) {
    return;
  }
  await installPackage(projectUri, item.info.name, version, `Updating ${item.info.name} to ${version}…`);
  provider.refresh();
}

async function renameProject(info: ProjectInfo, newName: string): Promise<void> {
  let solutionGuid: string | undefined;
  let originalRelativePath: string | undefined;
  let solutionDir: vscode.Uri | undefined;
  let slnText: string | undefined;
  const isSlnx = info.solutionUri?.fsPath.toLowerCase().endsWith(".slnx") ?? false;

  if (info.solutionUri) {
    solutionDir = vscode.Uri.joinPath(info.solutionUri, "..");
    originalRelativePath = toPosixRelative(solutionDir.fsPath, info.uri.fsPath);
    slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));
    if (!isSlnx) {
      solutionGuid = parseSolutionFile(slnText).find(
        (ref) => ref.relativePath.toLowerCase() === originalRelativePath!.toLowerCase(),
      )?.projectGuid;
    }
  }

  const oldCsprojUri = info.uri;
  let csprojUri = vscode.Uri.joinPath(info.uri, "..", `${newName}.csproj`);
  const renameRootDir = path.basename(info.rootDir.fsPath) === info.name;
  const oldRootDir = info.rootDir;
  let newRootDir: vscode.Uri | undefined;

  await vscode.workspace.fs.rename(oldCsprojUri, csprojUri);

  try {
    if (renameRootDir) {
      newRootDir = vscode.Uri.joinPath(info.rootDir, "..", newName);
      await vscode.workspace.fs.rename(oldRootDir, newRootDir);
      csprojUri = vscode.Uri.joinPath(newRootDir, `${newName}.csproj`);
    }

    if (info.solutionUri && solutionDir && slnText && originalRelativePath) {
      const newRelativePath = toPosixRelative(solutionDir.fsPath, csprojUri.fsPath);
      const newSlnText = isSlnx
        ? renameSlnxProjectEntry(slnText, originalRelativePath, newRelativePath)
        : solutionGuid
          ? renameProjectEntry(slnText, solutionGuid, newName, newRelativePath)
          : slnText;
      await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    }
  } catch (err) {
    await rollbackRenameProject(newRootDir, oldRootDir, csprojUri, oldCsprojUri, errorMessage(err));
    throw err;
  }
}

async function rollbackRenameProject(
  newRootDir: vscode.Uri | undefined,
  oldRootDir: vscode.Uri,
  csprojUri: vscode.Uri,
  oldCsprojUri: vscode.Uri,
  originalErrorMessage: string,
): Promise<void> {
  try {
    if (newRootDir) {
      await vscode.workspace.fs.rename(newRootDir, oldRootDir);
      const csprojUnderOldRoot = vscode.Uri.joinPath(oldRootDir, path.basename(csprojUri.fsPath));
      await vscode.workspace.fs.rename(csprojUnderOldRoot, oldCsprojUri);
    } else {
      await vscode.workspace.fs.rename(csprojUri, oldCsprojUri);
    }
  } catch (rollbackErr) {
    throw new Error(
      `Rename failed (${originalErrorMessage}) and automatic rollback also failed ` +
        `(${errorMessage(rollbackErr)}) — the project is left in an inconsistent state and must be fixed manually.`,
    );
  }
}

async function deleteItem(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  if (!isExistingItemTarget(item)) {
    return;
  }

  const itemName = getDisplayName(item);
  const message =
    item instanceof SolutionFolderTreeItem
      ? `Delete '${itemName}'? Projects it contains will also be removed from the solution. This action cannot be undone.`
      : `Delete '${itemName}'? This action cannot be undone.`;

  const confirmation = await vscode.window.showWarningMessage(message, { modal: true }, "Delete");
  if (confirmation !== "Delete") {
    return;
  }

  if (item instanceof ProjectTreeItem) {
    await deleteProject(item.info);
  } else if (item instanceof SolutionFolderTreeItem) {
    await deleteSolutionFolder(item.info);
  } else {
    await vscode.workspace.fs.delete(getEntryUri(item), { recursive: true, useTrash: true });
  }

  provider.refresh();
}

async function deleteProject(info: ProjectInfo): Promise<void> {
  await vscode.workspace.fs.delete(info.rootDir, { recursive: true, useTrash: true });

  if (info.solutionUri) {
    const solutionDir = vscode.Uri.joinPath(info.solutionUri, "..");
    const relativePath = toPosixRelative(solutionDir.fsPath, info.uri.fsPath);
    const slnText = new TextDecoder().decode(await vscode.workspace.fs.readFile(info.solutionUri));

    try {
      let newSlnText: string;
      if (info.solutionUri.fsPath.toLowerCase().endsWith(".slnx")) {
        newSlnText = removeSlnxProjectEntry(slnText, relativePath);
      } else {
        const guid = parseSolutionFile(slnText).find(
          (ref) => ref.relativePath.toLowerCase() === relativePath.toLowerCase(),
        )?.projectGuid;
        if (!guid) {return;}
        newSlnText = removeProjectEntry(slnText, guid);
      }
      await vscode.workspace.fs.writeFile(info.solutionUri, new TextEncoder().encode(newSlnText));
    } catch (err) {
      throw new Error(
        `Project files were deleted, but updating '${path.basename(info.solutionUri.fsPath)}' failed: ` +
          `${errorMessage(err)}. Remove the stale entry manually.`,
      );
    }
  }
}

function buildProject(item: ProjectTreeItem): void {
  runInTerminal("C# Solution Explorer: Build", `dotnet build "${item.info.uri.fsPath}"`);
}

function runProject(item: ProjectTreeItem): void {
  runInTerminal("C# Solution Explorer: Run", `dotnet run --project "${item.info.uri.fsPath}"`);
}

function runInTerminal(name: string, command: string): void {
  const terminal = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal(name);
  terminal.show();
  terminal.sendText(command);
}

function generateSlnGuid(): string {
  return `{${crypto.randomUUID().toUpperCase()}}`;
}

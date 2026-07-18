import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import {
  PackageReferenceTreeItem,
  ProjectReferenceTreeItem,
  ProjectTreeItem,
  SolutionExplorerTreeItem,
  SolutionTreeItem,
} from "./treeItems.js";
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
  OPEN_PROJECT_FILE_COMMAND_ID,
  OPEN_SETTINGS_COMMAND_ID,
  OPEN_SOLUTION_FILE_COMMAND_ID,
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
  UPDATE_PACKAGE_TO_LATEST_COMMAND_ID,
  OPEN_PACKAGE_MANAGER_COMMAND_ID,
  RESTORE_COMMAND_ID,
  CLEAN_COMMAND_ID,
  REBUILD_COMMAND_ID,
  TEST_COMMAND_ID,
  NEW_PROJECT_COMMAND_ID,
  REVEAL_IN_TREE_COMMAND_ID,
  COPY_COMMAND_ID,
  CUT_COMMAND_ID,
  PASTE_COMMAND_ID,
  OPEN_IN_TERMINAL_COMMAND_ID,
  REVEAL_IN_FINDER_COMMAND_ID,
  REVEAL_IN_EXPLORER_COMMAND_ID,
  REVEAL_IN_FILE_MANAGER_COMMAND_ID,
} from "./types.js";
import {
  ExistingItemTarget,
  FsItem,
  NewItemTarget,
  TerminalTarget,
  withErrorHandling,
} from "./commandUtils.js";
import {
  newClass,
  newEnum,
  newFile,
  newFolder,
  newInterface,
  newRazor,
  newRecord,
  newStruct,
} from "./newItemCommands.js";
import { deleteItem, rename } from "./renameDeleteCommands.js";
import {
  addExistingProject,
  newProject,
  newSolutionFolder,
  removeProjectFromSolution,
} from "./solutionCommands.js";
import { addProjectReference, removeProjectReference } from "./referenceCommands.js";
import {
  addPackageReference,
  openPackageManager,
  removePackageReference,
  updatePackageReference,
  updatePackageToLatest,
} from "./packageCommands.js";
import {
  buildTarget,
  cleanTarget,
  rebuildTarget,
  restoreTarget,
  runProject,
  testTarget,
} from "./buildCommands.js";
import { copyToClipboard, paste } from "./clipboardCommands.js";
import { openInTerminal, revealInOS, revealInTree } from "./revealCommands.js";

export function registerSolutionExplorerCommands(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
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
    vscode.commands.registerCommand(UPDATE_PACKAGE_TO_LATEST_COMMAND_ID, (item: PackageReferenceTreeItem) =>
      withErrorHandling(() => updatePackageToLatest(item, provider)),
    ),
    vscode.commands.registerCommand(OPEN_PACKAGE_MANAGER_COMMAND_ID, (item: unknown) =>
      withErrorHandling(() => openPackageManager(item, provider, context)),
    ),
    vscode.commands.registerCommand(BUILD_PROJECT_COMMAND_ID, (item: ProjectTreeItem | SolutionTreeItem) => buildTarget(item)),
    vscode.commands.registerCommand(REBUILD_COMMAND_ID, (item: ProjectTreeItem | SolutionTreeItem) => rebuildTarget(item)),
    vscode.commands.registerCommand(TEST_COMMAND_ID, (item: ProjectTreeItem | SolutionTreeItem) => testTarget(item)),
    vscode.commands.registerCommand(RUN_PROJECT_COMMAND_ID, (item: ProjectTreeItem) => runProject(item)),
    vscode.commands.registerCommand(NEW_PROJECT_COMMAND_ID, (item: unknown) =>
      withErrorHandling(() => newProject(item, provider)),
    ),
    vscode.commands.registerCommand(RESTORE_COMMAND_ID, (item: ProjectTreeItem | SolutionTreeItem) => restoreTarget(item)),
    vscode.commands.registerCommand(CLEAN_COMMAND_ID, (item: ProjectTreeItem | SolutionTreeItem) => cleanTarget(item)),
    vscode.commands.registerCommand(OPEN_SOLUTION_FILE_COMMAND_ID, (item: SolutionTreeItem) =>
      vscode.window.showTextDocument(item.info.uri),
    ),
    vscode.commands.registerCommand(OPEN_PROJECT_FILE_COMMAND_ID, (item: ProjectTreeItem) =>
      vscode.window.showTextDocument(item.info.uri),
    ),
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND_ID, () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:jomblebee.jomblebee-csharp-solution-explorer"),
    ),
    vscode.commands.registerCommand(REVEAL_IN_TREE_COMMAND_ID, (uri?: vscode.Uri) =>
      withErrorHandling(() => revealInTree(uri, provider, treeView)),
    ),
    vscode.commands.registerCommand(COPY_COMMAND_ID, (item?: FsItem, items?: FsItem[]) =>
      copyToClipboard(item, items, "copy", treeView),
    ),
    vscode.commands.registerCommand(CUT_COMMAND_ID, (item?: FsItem, items?: FsItem[]) =>
      copyToClipboard(item, items, "cut", treeView),
    ),
    vscode.commands.registerCommand(PASTE_COMMAND_ID, (item?: ExistingItemTarget) =>
      withErrorHandling(() => paste(item ?? treeView.selection[0], provider)),
    ),
    vscode.commands.registerCommand(OPEN_IN_TERMINAL_COMMAND_ID, (item: TerminalTarget) => openInTerminal(item)),
    // Three OS-specific ids share one handler so the menu label matches the platform
    // (Finder / File Explorer / file manager); the built-in command does the actual reveal.
    vscode.commands.registerCommand(REVEAL_IN_FINDER_COMMAND_ID, (item: unknown) => revealInOS(item)),
    vscode.commands.registerCommand(REVEAL_IN_EXPLORER_COMMAND_ID, (item: unknown) => revealInOS(item)),
    vscode.commands.registerCommand(REVEAL_IN_FILE_MANAGER_COMMAND_ID, (item: unknown) => revealInOS(item)),
  );
}

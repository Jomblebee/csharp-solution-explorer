import * as path from "node:path";
import * as vscode from "vscode";
import { basenameWithoutExtension } from "../fsPathUtils.js";
import { SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import {
  CSHARP_PROJECT_TYPE_GUID,
  parseSolutionConfigurations,
  parseSolutionFile,
  SOLUTION_FOLDER_TYPE_GUID,
  SolutionTreeNode,
} from "../parsers/slnParser.js";
import {
  addNestedProjectRelation,
  addProjectConfigurationPlatforms,
  addProjectEntry,
  removeProjectEntry,
} from "../parsers/slnWriter.js";
import {
  addSlnxFolderEntry,
  addSlnxProjectEntry,
  removeSlnxProjectEntry,
} from "../parsers/slnxWriter.js";
import { parseSlnxFile } from "../parsers/slnxParser.js";
import { newProject as scaffoldProject } from "../dotnetCli.js";
import { ProjectTreeItem, SolutionFolderTreeItem, SolutionTreeItem } from "../tree/treeItems.js";
import { generateSlnGuid, toPosixRelative, validateNewName } from "../commandUtils.js";

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

interface SolutionTarget {
  solutionUri: vscode.Uri;
  /** For .sln the parent solution folder's GUID; for .slnx the parent folder's name. Undefined at root. */
  parentFolder: string | undefined;
}

/** Resolves a right-clicked solution or solution-folder node to its solution file and parent folder. */
function resolveSolutionTarget(item: unknown): SolutionTarget | undefined {
  if (item instanceof SolutionTreeItem) {
    return { solutionUri: item.info.uri, parentFolder: undefined };
  }
  if (item instanceof SolutionFolderTreeItem) {
    return { solutionUri: item.info.solutionUri, parentFolder: item.info.guid };
  }
  return undefined;
}

/**
 * Registers an existing .csproj in the given solution (.sln or .slnx), nesting it under
 * `parentFolder` when set. No-op (with a warning) if the project is already part of the solution.
 */
async function addProjectToSolution(
  solutionUri: vscode.Uri,
  csprojUri: vscode.Uri,
  parentFolder: string | undefined,
): Promise<void> {
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
}

async function addExistingProject(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  const target = resolveSolutionTarget(item);
  if (!target) {
    return;
  }

  const selection = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Add Project",
    filters: { "Project Files": ["csproj", "fsproj", "vbproj"] },
  });
  if (!selection || selection.length === 0) {
    return;
  }

  await addProjectToSolution(target.solutionUri, selection[0], target.parentFolder);
  provider.refresh();
}

/** Curated `dotnet new` C# templates offered by the New Project command. */
const PROJECT_TEMPLATES: ReadonlyArray<{ template: string; label: string; detail: string }> = [
  { template: "console", label: "Console App", detail: "Command-line application" },
  { template: "classlib", label: "Class Library", detail: "Reusable library" },
  { template: "web", label: "ASP.NET Core Empty", detail: "Minimal web app" },
  { template: "webapi", label: "ASP.NET Core Web API", detail: "HTTP API with controllers" },
  { template: "mvc", label: "ASP.NET Core MVC", detail: "Web app with controllers and views" },
  { template: "razor", label: "ASP.NET Core Razor Pages", detail: "Page-based web app" },
  { template: "blazor", label: "Blazor Web App", detail: "Blazor full-stack web app" },
  { template: "worker", label: "Worker Service", detail: "Long-running background service" },
  { template: "xunit", label: "xUnit Test Project", detail: "Unit tests (xUnit)" },
  { template: "nunit", label: "NUnit Test Project", detail: "Unit tests (NUnit)" },
  { template: "mstest", label: "MSTest Test Project", detail: "Unit tests (MSTest)" },
];

async function newProject(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  const target = resolveSolutionTarget(item);
  if (!target) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    PROJECT_TEMPLATES.map((t) => ({ label: t.label, detail: t.detail, template: t.template })),
    { placeHolder: "Select a project template" },
  );
  if (!pick) {
    return;
  }

  const solutionDir = vscode.Uri.joinPath(target.solutionUri, "..").fsPath;
  const name = await vscode.window.showInputBox({
    prompt: "Project name",
    placeHolder: "MyProject",
    validateInput: (value) => validateNewName(value, solutionDir),
  });
  if (!name) {
    return;
  }

  const outputDir = path.join(solutionDir, name);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
    () => scaffoldProject(pick.template, name, outputDir),
  );

  const csprojUri = vscode.Uri.file(path.join(outputDir, `${name}.csproj`));
  await addProjectToSolution(target.solutionUri, csprojUri, target.parentFolder);
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

export { addExistingProject, newProject, newSolutionFolder, removeProjectFromSolution };

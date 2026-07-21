import * as path from "node:path";
import * as vscode from "vscode";
import { resolveOwningProjectUri } from "./commandUtils.js";
import { isDebuggableProject, parseOutputType, parseSdkAttribute } from "./csprojReader.js";
import { getStartupProjectFsPath, setStartupProject } from "./launchProfileState.js";

const EXCLUDE_GLOB = "**/{bin,obj,node_modules,.git,.vs}/**";

export interface TargetProject {
  name: string;
  uri: vscode.Uri;
  rootDir: vscode.Uri;
}

/** All projects in the workspace, sorted by name. Shared with the debugger's project picker. */
export async function findWorkspaceProjects(): Promise<TargetProject[]> {
  const uris = await vscode.workspace.findFiles("**/*.{csproj,fsproj,vbproj}", EXCLUDE_GLOB);
  return uris.map(toTargetProject).sort((a, b) => a.name.localeCompare(b.name));
}

export function projectFromUri(uri: vscode.Uri): TargetProject {
  return toTargetProject(uri);
}

export async function resolveTargetProject(item: unknown): Promise<TargetProject | undefined> {
  const fromNode = resolveOwningProjectUri(item);
  if (fromNode) {
    return toTargetProject(fromNode);
  }
  const startup = getStartupProjectFsPath();
  return startup ? toTargetProject(vscode.Uri.file(startup)) : undefined;
}

/**
 * Reads a project file and classifies it as runnable/debuggable without invoking MSBuild
 * (see `isDebuggableProject`). A read failure defaults to `true` — fail open, so a project
 * is never hidden just because its file could not be read.
 */
async function isProjectDebuggable(uri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    return isDebuggableProject(parseSdkAttribute(text), parseOutputType(text));
  } catch {
    return true;
  }
}

interface StartupProjectQuickPickItem extends vscode.QuickPickItem {
  project?: TargetProject;
  showOthers?: boolean;
}

function toStartupProjectItem(project: TargetProject): StartupProjectQuickPickItem {
  return {
    label: project.name,
    description: vscode.workspace.asRelativePath(project.uri),
    project,
  };
}

/** Asks which project to start, and remembers it — the picker doubles as "set startup project". */
export async function promptForStartupProject(): Promise<TargetProject | undefined> {
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects were found in this workspace.");
    return undefined;
  }

  const debuggableFlags = await Promise.all(projects.map((project) => isProjectDebuggable(project.uri)));
  const debuggable = projects.filter((_, i) => debuggableFlags[i]);
  const others = projects.filter((_, i) => !debuggableFlags[i]);

  // Nothing to collapse (e.g. a solution of libraries only) — fall back to showing everything.
  const primaryList = debuggable.length > 0 ? debuggable : projects;
  const collapsedList = debuggable.length > 0 ? others : [];

  const items: StartupProjectQuickPickItem[] = primaryList.map(toStartupProjectItem);
  if (collapsedList.length > 0) {
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      {
        label: `Show ${collapsedList.length} other project${collapsedList.length === 1 ? "" : "s"} (not runnable)`,
        showOthers: true,
      },
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Startup project",
    placeHolder: "Select the project to run",
  });
  if (!picked) {
    return undefined;
  }

  let project = picked.project;
  if (picked.showOthers) {
    const pickedOther = await vscode.window.showQuickPick(collapsedList.map(toStartupProjectItem), {
      title: "Startup project — not runnable",
      placeHolder: "Select the project to run",
    });
    project = pickedOther?.project;
  }
  if (!project) {
    return undefined;
  }

  setStartupProject(project.uri.fsPath);
  return project;
}

function toTargetProject(uri: vscode.Uri): TargetProject {
  return {
    name: path.basename(uri.fsPath, path.extname(uri.fsPath)),
    uri,
    rootDir: vscode.Uri.file(path.dirname(uri.fsPath)),
  };
}

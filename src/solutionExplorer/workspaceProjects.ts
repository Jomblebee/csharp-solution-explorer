import * as path from "node:path";
import * as vscode from "vscode";
import { resolveOwningProjectUri } from "./commandUtils.js";
import {
  isDebuggableProject,
  isTestProject,
  parseOutputType,
  parseSdkAttribute,
  parseTargetFrameworks,
} from "./csprojReader.js";
import { getStartupProjectFsPath, setStartupProject } from "./launchProfileState.js";
import { describeActiveProfile } from "./launchProfileCommands.js";

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

type ProjectGroup = "runnable" | "test" | "library";

interface ProjectClassification {
  group: ProjectGroup;
  targetFrameworks: string[];
}

/**
 * Reads a project file once and classifies it — test project, runnable/debuggable, or plain
 * library (see `isDebuggableProject`/`isTestProject`) — plus its target framework(s), all
 * without invoking MSBuild. A read failure fails open to a runnable project with no known
 * framework, so a project is never hidden just because its file could not be read.
 */
async function classifyProject(uri: vscode.Uri): Promise<ProjectClassification> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);
    const targetFrameworks = parseTargetFrameworks(text);
    if (isTestProject(text)) {
      return { group: "test", targetFrameworks };
    }
    const debuggable = isDebuggableProject(parseSdkAttribute(text), parseOutputType(text));
    return { group: debuggable ? "runnable" : "library", targetFrameworks };
  } catch {
    return { group: "runnable", targetFrameworks: [] };
  }
}

interface StartupProjectQuickPickItem extends vscode.QuickPickItem {
  project?: TargetProject;
}

const GROUP_ICON: Record<ProjectGroup, string> = {
  runnable: "$(play)",
  test: "$(beaker)",
  library: "$(library)",
};

const GROUP_LABEL: Record<ProjectGroup, string> = {
  runnable: "Runnable",
  test: "Tests",
  library: "Libraries",
};

const ASPNETCORE_ENVIRONMENT = "ASPNETCORE_ENVIRONMENT";

function toStartupProjectItem(
  project: TargetProject,
  classification: ProjectClassification,
  opts: { pinned: boolean; detail?: string },
): StartupProjectQuickPickItem {
  // Everything on one line (no `detail`), so consecutive entries stay visually separated rather than
  // blurring into 2-line blocks.
  const description = [classification.targetFrameworks.join(" · "), opts.detail].filter(Boolean).join("   ");
  return {
    label: `${GROUP_ICON[classification.group]} ${opts.pinned ? "$(star-full) " : ""}${project.name}`,
    description,
    project,
  };
}

/** For a runnable project, a one-line summary of the profile it will run with (for the picker detail). */
async function profileSummary(project: TargetProject): Promise<string | undefined> {
  const { label, profile } = await describeActiveProfile(project.uri, project.rootDir);
  const env = profile?.environmentVariables[ASPNETCORE_ENVIRONMENT];
  return `$(rocket) ${label}${env ? ` · ${env}` : ""}`;
}

/**
 * Asks which project to start, and remembers it — the picker doubles as "set startup project". A
 * `createQuickPick` so the pinned project can open pre-highlighted; runnable projects show the
 * launch profile they will run with, and the pinned one carries a star.
 */
export async function promptForStartupProject(): Promise<TargetProject | undefined> {
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects were found in this workspace.");
    return undefined;
  }

  const classifications = await Promise.all(projects.map((project) => classifyProject(project.uri)));
  const classified = projects.map((project, i) => ({ project, classification: classifications[i] }));
  const pinned = getStartupProjectFsPath();

  // Profile summaries only for runnable projects (tests/libraries do not run with a profile).
  const details = new Map<string, string | undefined>();
  await Promise.all(
    classified
      .filter((entry) => entry.classification.group === "runnable")
      .map(async (entry) => details.set(entry.project.uri.fsPath, await profileSummary(entry.project))),
  );

  // One flat list, but split into labeled sections so test projects sit in their own group
  // (they used to be lumped into a collapsed "not runnable" bucket) instead of hidden.
  const items: StartupProjectQuickPickItem[] = [];
  let preselect: StartupProjectQuickPickItem | undefined;
  let firstRunnable: StartupProjectQuickPickItem | undefined;
  for (const group of ["runnable", "test", "library"] as const) {
    const inGroup = classified.filter((entry) => entry.classification.group === group);
    if (inGroup.length === 0) {
      continue;
    }
    items.push({ label: GROUP_LABEL[group], kind: vscode.QuickPickItemKind.Separator });
    for (const { project, classification } of inGroup) {
      const isPinned = project.uri.fsPath === pinned;
      const item = toStartupProjectItem(project, classification, {
        pinned: isPinned,
        detail: details.get(project.uri.fsPath),
      });
      items.push(item);
      if (isPinned) {
        preselect = item;
      }
      if (group === "runnable" && !firstRunnable) {
        firstRunnable = item;
      }
    }
  }

  return new Promise<TargetProject | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<StartupProjectQuickPickItem>();
    qp.title = "Startup project";
    qp.placeholder = "Select the project to run";
    qp.items = items;
    const active = preselect ?? firstRunnable;
    if (active) {
      qp.activeItems = [active];
    }

    let result: TargetProject | undefined;
    qp.onDidAccept(() => {
      const [picked] = qp.selectedItems;
      if (picked?.project) {
        result = picked.project;
        setStartupProject(picked.project.uri.fsPath);
      }
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(result);
    });
    qp.show();
  });
}

function toTargetProject(uri: vscode.Uri): TargetProject {
  return {
    name: path.basename(uri.fsPath, path.extname(uri.fsPath)),
    uri,
    rootDir: vscode.Uri.file(path.dirname(uri.fsPath)),
  };
}

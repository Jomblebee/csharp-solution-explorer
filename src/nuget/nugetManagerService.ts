// The data/side-effect layer behind the NuGet manager webview. Everything the webview asks for
// (solution state, package details, available updates) and everything it triggers (install / update /
// uninstall across the checked projects) is resolved here by reusing the existing building blocks:
// the nuget.org client (nugetApi), the restore-output reader (projectAssetsReader), and the dotnet
// CLI wrapper (dotnetCli). The panel just marshals messages to and from these functions.

import * as path from "node:path";
import * as vscode from "vscode";
import { addPackage, removePackage, restore } from "../solutionExplorer/dotnetCli.js";
import { getAssetsFilePath } from "../solutionExplorer/parsers/projectAssetsReader.js";
import {
  ApplyProgress,
  applyPackageWith,
  ApplyResult,
  applyUpdatesWith,
  BatchEntryResult,
  PackageOps,
} from "./applyOperations.js";
import {
  getLatestStableVersion,
  getPackageMetadata,
  getPackageReadme,
  getPackageVersions,
} from "./nugetApi.js";
import { PackageMetadata } from "./packageMetadata.js";
import { computeUpdates, PackageUpdate } from "./updateCalculation.js";
import {
  ancestorDirectories,
  CentralPackageManagementInfo,
  decideCentralPackageManagement,
  PACKAGES_PROPS_FILENAME,
} from "./centralPackageManagement.js";
import { InstalledPackage, resolveInstalledPackages } from "./installedView.js";
import { parseSolutionProjects } from "./solutionProjects.js";

/** How many nuget.org version lookups the update check may have in flight at once. */
const UPDATE_CHECK_CONCURRENCY = 8;

export { InstalledPackage };
export { ApplyProgress, ApplyResult, BatchEntryResult };

/** The production wiring of the package operations: the real `dotnet` CLI. */
const dotnetOps: PackageOps = { add: addPackage, remove: removePackage, restore };

/** One project of the managed solution, with its directly-referenced packages. */
export interface ProjectState {
  name: string;
  fsPath: string;
  /** POSIX path relative to the solution directory — stable identity + compact display. */
  relativePath: string;
  packages: InstalledPackage[];
  /** Set when *this* project's versions come from a Directory.Packages.props. */
  centralPackageManagement?: {
    propsPath: string;
  };
}

export interface SolutionState {
  solutionName: string;
  projects: ProjectState[];
  /**
   * Set as soon as *any* project is centrally managed. Detection is per project — MSBuild resolves
   * `Directory.Packages.props` from each project directory upwards, not from the solution — but the
   * flag is a solution-wide rollup because the panel refuses writes outright under CPM. A per-project
   * gate would buy nothing while complicating every disabled-state check.
   */
  centralPackageManagement?: {
    /** POSIX path of the governing Directory.Packages.props, for the panel to name in its banner. */
    propsPath: string;
  };
}

export { PackageUpdate };

/** Rich details for the detail pane: registration metadata + all versions + rendered-elsewhere readme. */
export interface PackageDetails {
  metadata?: PackageMetadata;
  versions: string[];
  readme?: string;
}


/** Reads a solution file and returns its existing projects as `{ name, csprojUri }`. */
export async function listSolutionProjects(
  solutionUri: vscode.Uri,
): Promise<{ name: string; relativePath: string; csprojUri: vscode.Uri }[]> {
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(solutionUri));
  const isSlnx = solutionUri.fsPath.toLowerCase().endsWith(".slnx");
  const solutionDir = vscode.Uri.joinPath(solutionUri, "..");

  const result: { name: string; relativePath: string; csprojUri: vscode.Uri }[] = [];
  for (const project of parseSolutionProjects(text, isSlnx)) {
    const csprojUri = vscode.Uri.joinPath(solutionDir, ...project.relativePath.split("/"));
    try {
      await vscode.workspace.fs.stat(csprojUri);
    } catch {
      continue; // stale .sln entry — the .csproj no longer exists
    }
    result.push({ name: project.name, relativePath: project.relativePath, csprojUri });
  }
  return result;
}

/** Reads a UTF-8 file, or `undefined` when it does not exist / cannot be read. */
async function tryReadFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/**
 * Resolves the `Directory.Packages.props` governing one project, walking up from the *project*
 * directory the way MSBuild does — not from the solution directory, which gives the wrong answer for
 * any project living outside the solution's subtree.
 *
 * `cache` holds the *pending read* per directory so a solution whose projects share an ancestor reads
 * that props file once even while the projects are resolved in parallel. It is created per
 * `getSolutionState` call, so a refresh never serves stale text. The precedence rules themselves
 * live in `decideCentralPackageManagement`.
 */
async function resolveCentralPackageManagement(
  projectDir: string,
  cache: Map<string, Promise<string | undefined>>,
): Promise<CentralPackageManagementInfo | undefined> {
  const dirs = ancestorDirectories(projectDir);
  const texts = await Promise.all(
    dirs.map((dir) => {
      let read = cache.get(dir);
      if (!read) {
        read = tryReadFile(vscode.Uri.file(`${dir}/${PACKAGES_PROPS_FILENAME}`));
        cache.set(dir, read);
      }
      return read;
    }),
  );
  return decideCentralPackageManagement(dirs.map((dir, i) => ({ dir, text: texts[i] })));
}

/** Reads the sources a project's package versions can come from and resolves them to a list. */
async function readDirectPackages(
  csprojUri: vscode.Uri,
  central: CentralPackageManagementInfo | undefined,
): Promise<InstalledPackage[]> {
  const assetsPath = getAssetsFilePath(path.dirname(csprojUri.fsPath));
  const [assetsText, csprojText] = await Promise.all([
    tryReadFile(vscode.Uri.file(assetsPath)),
    tryReadFile(csprojUri),
  ]);
  return resolveInstalledPackages({ assetsText, csprojText, centralVersions: central?.versions });
}

/** Builds the full solution state (projects + their installed direct packages) for the webview. */
export async function getSolutionState(solutionUri: vscode.Uri): Promise<SolutionState> {
  const projects = await listSolutionProjects(solutionUri);
  const propsCache = new Map<string, Promise<string | undefined>>();
  const states = await Promise.all(
    projects.map(async (project): Promise<ProjectState> => {
      const central = await resolveCentralPackageManagement(path.dirname(project.csprojUri.fsPath), propsCache);
      return {
        name: project.name,
        fsPath: project.csprojUri.fsPath,
        relativePath: project.relativePath,
        packages: await readDirectPackages(project.csprojUri, central),
        centralPackageManagement: central ? { propsPath: central.propsPath } : undefined,
      };
    }),
  );
  const centrallyManaged = states.find((state) => state.centralPackageManagement);
  return {
    solutionName: basename(solutionUri),
    projects: states,
    centralPackageManagement: centrallyManaged?.centralPackageManagement,
  };
}

/** Computes which installed packages have a newer stable release (see `computeUpdates` for the rules). */
export function getUpdates(state: SolutionState): Promise<PackageUpdate[]> {
  return computeUpdates(state.projects, getLatestStableVersion, UPDATE_CHECK_CONCURRENCY);
}

/** Loads registration metadata, the version list, and the README for the detail pane. */
export async function getPackageDetails(id: string, version?: string): Promise<PackageDetails> {
  const [metadata, versions] = await Promise.all([
    getPackageMetadata(id, version).catch(() => undefined),
    getPackageVersions(id, { prerelease: true }).catch(() => [] as string[]),
  ]);
  const readmeVersion = version ?? metadata?.version ?? versions[0];
  const readme = readmeVersion ? await getPackageReadme(id, readmeVersion).catch(() => undefined) : undefined;
  return { metadata, versions, readme };
}

/** Applies one package operation across `projects` via the real CLI (see `applyPackageWith`). */
export function applyPackage(
  op: "install" | "update" | "uninstall",
  id: string,
  version: string | undefined,
  projects: { name: string; fsPath: string }[],
  onProgress?: (progress: ApplyProgress) => void,
  token?: vscode.CancellationToken,
): Promise<ApplyResult[]> {
  return applyPackageWith(dotnetOps, op, id, version, projects, onProgress, token);
}

/** Updates several packages in one go via the real CLI (see `applyUpdatesWith`). */
export function applyUpdates(
  entries: { id: string; version: string; projects: { name: string; fsPath: string }[] }[],
  onProgress?: (progress: ApplyProgress) => void,
  token?: vscode.CancellationToken,
): Promise<BatchEntryResult[]> {
  return applyUpdatesWith(dotnetOps, entries, onProgress, token);
}

/**
 * Finds the solution files in the workspace (matching the tree's discovery). Used when the manager is
 * opened without a solution context (e.g. the command palette).
 */
export async function findWorkspaceSolutions(): Promise<vscode.Uri[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found: vscode.Uri[] = [];
  for (const folder of folders) {
    const exclude = new vscode.RelativePattern(folder, "**/{node_modules,bin,obj,.git,.vs}/**");
    found.push(
      ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.sln"), exclude)),
      ...(await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.slnx"), exclude)),
    );
  }
  return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

function basename(uri: vscode.Uri): string {
  return path.basename(uri.fsPath).replace(/\.slnx?$/i, "");
}

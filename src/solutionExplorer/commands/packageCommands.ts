import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "../tree/solutionTreeDataProvider.js";
import { addPackage, removePackage, restore } from "../dotnetCli.js";
import { getPackageVersions, NugetPackage, searchPackages } from "../../nuget/nugetApi.js";
import { findWorkspaceSolutions } from "../../nuget/nugetManagerService.js";
import { NugetManagerPanel } from "../../nuget/nugetManagerPanel.js";
import {
  DependenciesTreeItem,
  DependencyCategoryTreeItem,
  PackageReferenceTreeItem,
  ProjectTreeItem,
  SolutionTreeItem,
} from "../tree/treeItems.js";
import { errorMessage, resolveOwningProjectUri } from "../commandUtils.js";
import { debounce } from "../../shared/debounce.js";

interface PackagePickItem extends vscode.QuickPickItem {
  id: string;
}

function formatDownloads(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
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

export async function addPackageReference(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
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

export async function removePackageReference(
  item: PackageReferenceTreeItem,
  provider: SolutionTreeDataProvider,
): Promise<void> {
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

export async function updatePackageReference(
  item: PackageReferenceTreeItem,
  provider: SolutionTreeDataProvider,
): Promise<void> {
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

/** The solution to manage plus the project to pre-check, derived from the right-clicked tree node. */
function resolveManagerContext(item: unknown): { solutionUri?: vscode.Uri; preselectFsPath?: string } {
  if (item instanceof SolutionTreeItem) {
    return { solutionUri: item.info.uri };
  }
  if (item instanceof ProjectTreeItem) {
    return { solutionUri: item.info.solutionUri, preselectFsPath: item.info.uri.fsPath };
  }
  if (item instanceof DependenciesTreeItem) {
    return { solutionUri: item.project.solutionUri, preselectFsPath: item.project.uri.fsPath };
  }
  if (item instanceof DependencyCategoryTreeItem) {
    return { preselectFsPath: item.info.dependencies.projectUri.fsPath };
  }
  if (item instanceof PackageReferenceTreeItem) {
    return { preselectFsPath: item.info.projectUri?.fsPath };
  }
  return {};
}

/** Opens the rich, solution-wide NuGet package manager webview. */
export async function openPackageManager(
  item: unknown,
  provider: SolutionTreeDataProvider,
  context: vscode.ExtensionContext,
): Promise<void> {
  const { solutionUri: fromNode, preselectFsPath } = resolveManagerContext(item);
  let solutionUri = fromNode;
  if (!solutionUri) {
    const solutions = await findWorkspaceSolutions();
    if (solutions.length === 0) {
      vscode.window.showInformationMessage(
        "The NuGet Package Manager works on a solution (.sln/.slnx), but none was found in this workspace.",
      );
      return;
    }
    solutionUri =
      solutions.length === 1
        ? solutions[0]
        : (
            await vscode.window.showQuickPick(
              solutions.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
              { placeHolder: "Select the solution to manage packages for" },
            )
          )?.uri;
  }
  if (solutionUri) {
    NugetManagerPanel.createOrShow(context, provider, solutionUri, preselectFsPath);
  }
}

/** One-click update of an outdated package to the latest version already resolved on its tree item. */
export async function updatePackageToLatest(
  item: PackageReferenceTreeItem,
  provider: SolutionTreeDataProvider,
): Promise<void> {
  const projectUri = item.info.projectUri;
  const latest = item.info.latestVersion;
  if (!projectUri || !latest) {
    return;
  }
  await installPackage(projectUri, item.info.name, latest, `Updating ${item.info.name} to ${latest}…`);
  provider.refresh();
}

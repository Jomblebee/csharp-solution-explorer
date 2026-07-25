// Makes sure a project can actually collect coverage before a coverage run starts. Both runners
// need an extra package (see coveragePackages.ts) and both fail badly without it — MTP aborts the
// whole run on the unknown `--coverage` option, VSTest runs and silently writes no report — so this
// resolves support, offers to install what is missing, and reports back whether the run may proceed.

import * as vscode from "vscode";
import * as path from "node:path";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { addPackage, restore } from "../solutionExplorer/dotnetCli.js";
import { getAssetsFilePath, parseProjectAssets, type ParsedAssets } from "../solutionExplorer/parsers/projectAssetsReader.js";
import { getPackageVersions } from "../nuget/nugetApi.js";
import {
  MTP_COVERAGE_PACKAGE,
  MTP_PLATFORM_PACKAGE,
  coverageExtensionMajor,
  coveragePackageId,
  hasCoveragePackage,
  hasMtpCoveragePackageInAssets,
  pickVersionForMajor,
  platformMajor,
} from "./coveragePackages.js";

/** The subset of a runnable entry this module needs: which item to key support by, and which project. */
export interface CoverageCandidate {
  projectItem: vscode.TestItem;
  project: TargetProject;
}

/**
 * Ensures each project selected for a coverage run has its coverage package. Resolves support from
 * the restored dependency graph (authoritative, and fresh — the project may have been restored since
 * the last refresh), prompts once if any project is missing it, and on "Add & Continue" installs it.
 * Returns whether the run should proceed — false only when the user dismisses the prompt (cancel).
 */
export async function ensureCoveragePackages(
  runnable: CoverageCandidate[],
  coveragePkgOkById: Map<string, boolean>,
  mtpById: Map<string, boolean>,
): Promise<boolean> {
  const assetsById = new Map<string, ParsedAssets | undefined>();
  await Promise.all(
    runnable.map(async ({ projectItem, project }) => {
      const support = await resolveCoverageSupport(project.uri, mtpById.get(projectItem.id) ?? false);
      coveragePkgOkById.set(projectItem.id, support.supported);
      assetsById.set(projectItem.id, support.assets);
    }),
  );

  const missing = runnable.filter((e) => !coveragePkgOkById.get(e.projectItem.id));
  if (missing.length === 0) {
    return true;
  }

  const names = missing.map((e) => e.project.name).join(", ");
  const choice = await vscode.window.showWarningMessage(
    `Code coverage needs an extra package in: ${names}. Add it and continue?`,
    { modal: true },
    "Add & Continue",
    "Run without coverage",
  );
  if (choice === undefined) {
    return false; // dismissed → cancel the run
  }
  if (choice !== "Add & Continue") {
    return true; // run without coverage for the missing projects
  }

  for (const { projectItem, project } of missing) {
    const mtp = mtpById.get(projectItem.id) ?? false;
    const packageId = coveragePackageId(mtp);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Adding ${packageId} to ${project.name}…` },
        async () => {
          // The MTP extension must match the platform major the framework brought in; installing the
          // newest one on an older platform builds fine and then kills the host at startup.
          const version = mtp ? await resolveMtpCoverageVersion(assetsById.get(projectItem.id)) : undefined;
          if (mtp && !version) {
            throw new Error(
              `could not determine a version of ${MTP_COVERAGE_PACKAGE} compatible with this project's ${MTP_PLATFORM_PACKAGE}. Add it manually.`,
            );
          }
          await addPackage(project.uri.fsPath, packageId, version);
        },
      );
      coveragePkgOkById.set(projectItem.id, true);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Could not add ${packageId} to ${project.name}: ${detail}`);
    }
  }
  return true;
}

/**
 * Whether a project has its runner's coverage package, plus the parsed assets (reused for version
 * selection). MTP asks the restored graph, since the extension usually arrives transitively with the
 * test framework; VSTest asks the csproj, where coverlet.collector must be a direct reference anyway
 * and which — unlike a restore output — can never be stale. Fails closed: claiming support that
 * isn't there makes an MTP run abort on an unknown `--coverage` option, while a wrong "missing" only
 * costs a prompt.
 */
async function resolveCoverageSupport(
  projectUri: vscode.Uri,
  mtp: boolean,
): Promise<{ supported: boolean; assets: ParsedAssets | undefined }> {
  const assets = mtp ? await readFreshAssets(projectUri) : undefined;
  if (assets) {
    return { supported: hasMtpCoveragePackageInAssets(assets), assets };
  }
  try {
    return { supported: hasCoveragePackage(await readText(projectUri), mtp), assets: undefined };
  } catch {
    return { supported: false, assets: undefined };
  }
}

/**
 * The project's restored dependency graph, restoring first when it is missing or older than the
 * csproj. A graph that predates the last project edit is worse than none: it can still list a
 * coverage package the user has since removed, and acting on that sends `--coverage` to a host that
 * rejects it and aborts the run. A coverage run is about to build anyway, so the cost is minor.
 */
async function readFreshAssets(projectUri: vscode.Uri): Promise<ParsedAssets | undefined> {
  const assetsUri = vscode.Uri.file(getAssetsFilePath(path.dirname(projectUri.fsPath)));
  if (await isStale(projectUri, assetsUri)) {
    try {
      await restore(projectUri.fsPath);
    } catch {
      /* the read below decides */
    }
  }
  return readAssets(assetsUri);
}

/** Whether the assets file is missing or predates the project file. */
async function isStale(projectUri: vscode.Uri, assetsUri: vscode.Uri): Promise<boolean> {
  try {
    const [project, assets] = await Promise.all([
      vscode.workspace.fs.stat(projectUri),
      vscode.workspace.fs.stat(assetsUri),
    ]);
    return assets.mtime < project.mtime;
  } catch {
    return true; // no assets file (or no project file) — a restore is the only way to learn more
  }
}

async function readAssets(assetsUri: vscode.Uri): Promise<ParsedAssets | undefined> {
  try {
    return parseProjectAssets(await readText(assetsUri));
  } catch {
    return undefined;
  }
}

/**
 * The newest CodeCoverage extension version whose major matches the project's MTP platform major.
 * Returns undefined rather than guessing — see `coverageExtensionMajor`.
 */
async function resolveMtpCoverageVersion(assets: ParsedAssets | undefined): Promise<string | undefined> {
  const major = assets ? coverageExtensionMajor(platformMajor(assets)) : undefined;
  if (major === undefined) {
    return undefined;
  }
  try {
    return pickVersionForMajor(await getPackageVersions(MTP_COVERAGE_PACKAGE), major);
  } catch {
    return undefined;
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

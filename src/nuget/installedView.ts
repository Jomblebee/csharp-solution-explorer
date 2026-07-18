// What the manager knows about the packages a solution already has installed, and what it derives
// from that: the Installed list, the per-project lookups, and the project sets an update or a
// consolidation would touch. Free of vscode and of the filesystem — the caller reads the files and
// hands the text in — so all of it stays unit-testable.

import { parsePackageReferences } from "../solutionExplorer/csprojReader.js";
import { parseProjectAssets } from "../solutionExplorer/projectAssetsReader.js";
import { compareVersions } from "./nugetApi.js";
import { CentralPackageVersion } from "./centralPackageManagement.js";

export interface InstalledPackage {
  /** Package id in its original (project-file) casing, for display. */
  id: string;
  version: string;
}

/** The three places a project's direct package versions can come from, best source first. */
export interface PackageSources {
  /** `obj/project.assets.json`, present only after a restore. Carries *resolved* versions. */
  assetsText?: string;
  csprojText?: string;
  /** `<PackageVersion>` entries from a governing Directory.Packages.props, under CPM. */
  centralVersions?: readonly CentralPackageVersion[];
}

/**
 * A project's directly-referenced packages. The restore output is the better source — it carries the
 * resolved versions — but it only exists after a restore, so a project that has never been built
 * falls back to its `<PackageReference>` elements. Under Central Package Management those carry no
 * version at all, so the governing props file supplies it; without that fallback a CPM project that
 * has not been restored would look like it had no packages.
 */
export function resolveInstalledPackages(sources: PackageSources): InstalledPackage[] {
  if (sources.assetsText !== undefined) {
    return parseProjectAssets(sources.assetsText)
      .packages.filter((pkg) => pkg.version)
      .map((pkg) => ({ id: pkg.name, version: pkg.version as string }));
  }
  if (sources.csprojText === undefined) {
    return [];
  }
  // Package ids are case-insensitive, and a props file may well spell one differently from the
  // project that references it, so the central lookup is keyed lowercased.
  const central = new Map<string, string>();
  for (const entry of sources.centralVersions ?? []) {
    if (entry.version) {
      central.set(entry.name.toLowerCase(), entry.version);
    }
  }
  const resolved: InstalledPackage[] = [];
  for (const ref of parsePackageReferences(sources.csprojText)) {
    const version = ref.version ?? central.get(ref.name.toLowerCase());
    if (version) {
      resolved.push({ id: ref.name, version });
    }
  }
  return resolved;
}

/** Just enough of a project for the views below — the manager's `ProjectState` satisfies it. */
export interface ProjectWithPackages {
  name: string;
  fsPath: string;
  packages: readonly InstalledPackage[];
}

/** A project as the webview names it back to us when asking for an operation. */
export interface ProjectRef {
  name: string;
  fsPath: string;
}

/** The version of `id` installed in one project, or `undefined` when it does not reference it. */
export function installedVersionInProject(project: ProjectWithPackages, id: string): string | undefined {
  const wanted = id.toLowerCase();
  return project.packages.find((pkg) => pkg.id.toLowerCase() === wanted)?.version;
}

function toRef(project: ProjectWithPackages): ProjectRef {
  return { name: project.name, fsPath: project.fsPath };
}

/**
 * Projects holding `id` at a *strictly older* version — the set an update would move up. Directional
 * on purpose: an update must never walk a project backwards. Note this is a version comparison, not
 * a string one, so a project pinned to `9.0` is correctly left alone when the target is `9.0.0`.
 */
export function projectsBelowVersion(
  projects: readonly ProjectWithPackages[],
  id: string,
  target: string,
): ProjectRef[] {
  return projects
    .filter((project) => {
      const version = installedVersionInProject(project, id);
      return version !== undefined && compareVersions(version, target) < 0;
    })
    .map(toRef);
}

/**
 * Projects holding `id` at a version *different* from `target` — the set a consolidation would move.
 * Unlike `projectsBelowVersion` this deliberately includes projects that are *ahead* of the target:
 * consolidating onto a chosen version means downgrading the projects above it too, which is the
 * whole point of the action.
 */
export function projectsNotAtVersion(
  projects: readonly ProjectWithPackages[],
  id: string,
  target: string,
): ProjectRef[] {
  return projects
    .filter((project) => {
      const version = installedVersionInProject(project, id);
      return version !== undefined && compareVersions(version, target) !== 0;
    })
    .map(toRef);
}

/** Projects that reference `id` at all — the authoritative filter for an uninstall. */
export function projectsWithPackage(projects: readonly ProjectWithPackages[], id: string): ProjectRef[] {
  return projects.filter((project) => installedVersionInProject(project, id) !== undefined).map(toRef);
}

export interface InstalledEntry {
  /** First-seen spelling of the id, so the display name does not flip between projects. */
  id: string;
  /** Distinct installed versions, newest first. */
  versions: string[];
  /** How many projects reference the package. */
  projects: number;
}

/**
 * Adds `version` to `versions` unless an equivalent version is already there. Equivalence is by
 * `compareVersions`, not by string: `9.0` and `9.0.0` are the same release, and treating them as two
 * would invent a consolidation that has nothing to consolidate.
 */
function addDistinctVersion(versions: string[], version: string): void {
  if (!versions.some((known) => compareVersions(known, version) === 0)) {
    versions.push(version);
  }
}

/** Collapses the per-project package lists into one entry per (case-insensitive) package id. */
export function aggregateInstalled(projects: readonly ProjectWithPackages[]): InstalledEntry[] {
  const entries = new Map<string, InstalledEntry>();
  for (const project of projects) {
    for (const pkg of project.packages) {
      const key = pkg.id.toLowerCase();
      let entry = entries.get(key);
      if (!entry) {
        entry = { id: pkg.id, versions: [], projects: 0 };
        entries.set(key, entry);
      }
      addDistinctVersion(entry.versions, pkg.version);
      entry.projects += 1;
    }
  }
  for (const entry of entries.values()) {
    entry.versions.sort((a, b) => compareVersions(b, a));
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface ConsolidateVersion {
  version: string;
  projects: ProjectRef[];
}

export interface ConsolidateEntry {
  id: string;
  /** Newest first; always at least two, or the package would not need consolidating. */
  versions: ConsolidateVersion[];
}

/**
 * Packages that sit at more than one version across the solution — Visual Studio's "Consolidate"
 * list. Each entry carries every version with the projects on it, so the panel can offer any of
 * them as the target.
 */
export function computeConsolidation(projects: readonly ProjectWithPackages[]): ConsolidateEntry[] {
  const result: ConsolidateEntry[] = [];
  for (const entry of aggregateInstalled(projects)) {
    if (entry.versions.length < 2) {
      continue;
    }
    result.push({
      id: entry.id,
      versions: entry.versions.map((version) => ({
        version,
        // Not `projectsNotAtVersion`'s inverse by accident: a project pinned to `9.0` belongs to the
        // `9.0.0` group, so membership is decided by comparison, matching how the versions were
        // collapsed in the first place.
        projects: projects
          .filter((project) => {
            const installed = installedVersionInProject(project, entry.id);
            return installed !== undefined && compareVersions(installed, version) === 0;
          })
          .map(toRef),
      })),
    });
  }
  return result;
}

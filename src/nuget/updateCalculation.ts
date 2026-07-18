// The "which packages can move up?" logic, kept free of vscode and of the network so it can be unit
// tested. The caller supplies the lookup; this module only decides what to ask about and what counts
// as an update. The FS/vscode-facing wrapper lives in nugetManagerService.

import { compareVersions } from "./nugetApi.js";
import { mapLimit } from "./concurrency.js";

/** Just enough of a project to compute updates from — the manager's `ProjectState` satisfies this. */
export interface ProjectPackages {
  packages: { id: string; version: string }[];
}

export interface PackageUpdate {
  id: string;
  /** Highest installed version across the solution. */
  installed: string;
  latest: string;
}

/**
 * Collapses the per-project package lists into one entry per package id, keeping the *highest*
 * installed version. Package ids are case-insensitive on nuget.org, so entries are keyed lowercased
 * while the first-seen spelling is preserved for display.
 */
export function highestInstalledVersions(projects: readonly ProjectPackages[]): { id: string; version: string }[] {
  const highest = new Map<string, { id: string; version: string }>();
  for (const project of projects) {
    for (const pkg of project.packages) {
      const key = pkg.id.toLowerCase();
      const current = highest.get(key);
      if (!current || compareVersions(pkg.version, current.version) > 0) {
        // Keep the spelling already recorded, so the display id doesn't flip between projects.
        highest.set(key, { id: current?.id ?? pkg.id, version: pkg.version });
      }
    }
  }
  return [...highest.values()];
}

/**
 * Computes which installed packages have a newer release. The baseline is the highest version across
 * all projects, so a package is only flagged when *some* project could actually move up.
 *
 * `getLatest` is called at most `concurrency` times in parallel; a package whose lookup fails or
 * returns nothing is silently left out rather than failing the whole check.
 */
export async function computeUpdates(
  projects: readonly ProjectPackages[],
  getLatest: (id: string) => Promise<string | undefined>,
  concurrency = 8,
): Promise<PackageUpdate[]> {
  const candidates = await mapLimit(highestInstalledVersions(projects), concurrency, async ({ id, version }) => {
    const latest = await getLatest(id).catch(() => undefined);
    return latest && compareVersions(latest, version) > 0 ? { id, installed: version, latest } : undefined;
  });
  return candidates
    .filter((update): update is PackageUpdate => update !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

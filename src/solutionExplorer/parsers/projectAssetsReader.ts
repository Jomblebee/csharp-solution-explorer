import * as path from "node:path";

/**
 * Reads NuGet's `obj/project.assets.json` restore output. This is the same source Visual Studio's
 * Solution Explorer uses to populate the Dependencies node, so it gives the fullest fidelity:
 * resolved frameworks, direct vs. transitive packages, and analyzer assemblies. Parsing is pure
 * JSON (no MSBuild, no vscode dependency) so it stays unit-testable.
 */

/** POSIX path of the assets file for a project, relative to its root directory. */
export function getAssetsFilePath(projectRootDir: string): string {
  return path.join(projectRootDir, "obj", "project.assets.json");
}

export interface ParsedAssetPackage {
  name: string;
  version?: string;
  /** Transitive (pulled-in) children of this package. */
  dependencies: ParsedAssetPackage[];
}

export interface ParsedAssetFramework {
  name: string;
  version?: string;
}

export interface ParsedAssetAnalyzer {
  name: string;
  version?: string;
}

export interface ParsedAssets {
  frameworks: ParsedAssetFramework[];
  /** Direct (top-level) packages; transitive packages are nested under `dependencies`. */
  packages: ParsedAssetPackage[];
  analyzers: ParsedAssetAnalyzer[];
}

interface TargetEntry {
  type?: string;
  dependencies?: Record<string, string>;
}

interface ProjectFramework {
  dependencies?: Record<string, { target?: string; version?: string }>;
  frameworkReferences?: Record<string, unknown>;
}

interface AssetsJson {
  targets?: Record<string, Record<string, TargetEntry>>;
  libraries?: Record<string, { type?: string; files?: string[] }>;
  project?: { frameworks?: Record<string, ProjectFramework> };
}

const EMPTY: ParsedAssets = { frameworks: [], packages: [], analyzers: [] };
const ANALYZER_DLL_PATTERN = /(^|\/)analyzers\/.*\.dll$/i;

/** Extracts a plain version (e.g. `9.0.0`) from a NuGet range like `[9.0.0, )` or a bare version. */
function extractVersion(range: string | undefined): string | undefined {
  return range ? /(\d+\.\d+[\w.\-+*]*)/.exec(range)?.[1] : undefined;
}

/** Splits a `Name/Version` library/target key into its parts. */
function splitNameVersion(key: string): { name: string; version?: string } {
  const slash = key.indexOf("/");
  return slash === -1 ? { name: key } : { name: key.slice(0, slash), version: key.slice(slash + 1) };
}

export function parseProjectAssets(jsonText: string): ParsedAssets {
  let data: AssetsJson;
  try {
    data = JSON.parse(jsonText) as AssetsJson;
  } catch {
    return EMPTY;
  }

  const projectFrameworks = data.project?.frameworks ?? {};
  const tfm = Object.keys(projectFrameworks)[0];
  if (!tfm) {
    return EMPTY;
  }

  const targets = data.targets ?? {};
  const targetKey = targets[tfm] ? tfm : Object.keys(targets)[0];
  const targetEntries = (targetKey ? targets[targetKey] : undefined) ?? {};

  // name (lowercased) -> resolved version + child dependency names, for transitive resolution.
  const resolution = new Map<string, { version?: string; deps: string[] }>();
  for (const [key, entry] of Object.entries(targetEntries)) {
    if (entry.type && entry.type !== "package") {
      continue;
    }
    const { name, version } = splitNameVersion(key);
    resolution.set(name.toLowerCase(), { version, deps: Object.keys(entry.dependencies ?? {}) });
  }

  const frameworks = parseFrameworks(projectFrameworks[tfm]);
  const packages = parsePackages(projectFrameworks[tfm], resolution);
  const analyzers = parseAnalyzers(data.libraries ?? {});

  return { frameworks, packages, analyzers };
}

function parseFrameworks(framework: ProjectFramework | undefined): ParsedAssetFramework[] {
  // Microsoft.NETCore.App is the base shared framework for every SDK-style project and is implicit
  // (never listed in frameworkReferences); web/desktop frameworks appear explicitly.
  const names = new Set<string>(["Microsoft.NETCore.App"]);
  for (const name of Object.keys(framework?.frameworkReferences ?? {})) {
    names.add(name);
  }
  return [...names].map((name) => ({ name }));
}

function parsePackages(
  framework: ProjectFramework | undefined,
  resolution: Map<string, { version?: string; deps: string[] }>,
): ParsedAssetPackage[] {
  const direct = Object.entries(framework?.dependencies ?? {}).filter(([, dep]) => dep.target !== "Project");
  return direct.map(([name, dep]) => resolvePackage(name, extractVersion(dep.version), resolution, new Set()));
}

function resolvePackage(
  name: string,
  fallbackVersion: string | undefined,
  resolution: Map<string, { version?: string; deps: string[] }>,
  visited: Set<string>,
): ParsedAssetPackage {
  const lower = name.toLowerCase();
  const resolved = resolution.get(lower);
  // Guard against dependency cycles: don't re-expand a package already on the current path.
  if (!resolved || visited.has(lower)) {
    return { name, version: resolved?.version ?? fallbackVersion, dependencies: [] };
  }
  const nextVisited = new Set(visited).add(lower);
  const dependencies = resolved.deps
    .filter((dep) => resolution.has(dep.toLowerCase()))
    .map((dep) => resolvePackage(dep, undefined, resolution, nextVisited));
  return { name, version: resolved.version ?? fallbackVersion, dependencies };
}

function parseAnalyzers(libraries: Record<string, { type?: string; files?: string[] }>): ParsedAssetAnalyzer[] {
  const byName = new Map<string, ParsedAssetAnalyzer>();
  for (const [key, library] of Object.entries(libraries)) {
    const { version } = splitNameVersion(key);
    for (const file of library.files ?? []) {
      if (!ANALYZER_DLL_PATTERN.test(file)) {
        continue;
      }
      const dllName = (file.split("/").pop() ?? file).replace(/\.dll$/i, "");
      if (!byName.has(dllName)) {
        byName.set(dllName, { name: dllName, version });
      }
    }
  }
  return [...byName.values()];
}

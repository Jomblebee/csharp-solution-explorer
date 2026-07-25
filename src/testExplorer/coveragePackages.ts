// Which NuGet package a test project needs before code coverage produces anything, keyed by runner.
// Pure and vscode-free so it stays unit-testable. MTP projects need the CodeCoverage extension (its
// `--coverage*` options don't exist otherwise — the runner aborts); classic VSTest projects need
// coverlet.collector to back `--collect "XPlat Code Coverage"` (missing it is silent-empty, not fatal).

import { parsePackageReferences } from "../solutionExplorer/parsers/csprojReader.js";
import type { ParsedAssetPackage, ParsedAssets } from "../solutionExplorer/parsers/projectAssetsReader.js";

/** The MTP code-coverage extension package (adds the `--coverage*` runner options). */
export const MTP_COVERAGE_PACKAGE = "Microsoft.Testing.Extensions.CodeCoverage";

/** The classic VSTest coverage collector backing `--collect "XPlat Code Coverage"`. */
export const VSTEST_COVERAGE_PACKAGE = "coverlet.collector";

/** The MTP runtime whose major decides which CodeCoverage extension major is loadable. */
export const MTP_PLATFORM_PACKAGE = "Microsoft.Testing.Platform";

/** MTP platform major → the only CodeCoverage extension major that can load against it. */
const PLATFORM_TO_COVERAGE_MAJOR: Record<number, number> = { 1: 17, 2: 18 };

/** The coverage package a project needs, chosen by its runner. */
export function coveragePackageId(mtp: boolean): string {
  return mtp ? MTP_COVERAGE_PACKAGE : VSTEST_COVERAGE_PACKAGE;
}

/** Whether the project already references the coverage package appropriate for its runner. */
export function hasCoveragePackage(csprojText: string, mtp: boolean): boolean {
  const marker = coveragePackageId(mtp).toLowerCase();
  return parsePackageReferences(csprojText).some((ref) => ref.name.toLowerCase().includes(marker));
}

/**
 * Whether the restored dependency graph contains the MTP CodeCoverage extension, at any depth.
 *
 * Reading the csproj is not enough here: MTP test frameworks bring the extension with them, so
 * MSTest (with `EnableMSTestRunner`) and TUnit collect coverage without ever naming it — it
 * self-registers through its `buildTransitive` assets. There is no VSTest counterpart, because
 * coverlet.collector has no transitive effect and must be referenced directly, which the csproj
 * answers exactly and without the staleness of a restore output.
 *
 * Caveat inherited from `parseProjectAssets`: only the first target framework of a multi-targeted
 * project is considered.
 */
export function hasMtpCoveragePackageInAssets(assets: ParsedAssets): boolean {
  const marker = MTP_COVERAGE_PACKAGE.toLowerCase();
  return findPackage(assets.packages, (name) => name.toLowerCase().includes(marker)) !== undefined;
}

/** The resolved major version of Microsoft.Testing.Platform in the restored graph. */
export function platformMajor(assets: ParsedAssets): number | undefined {
  const marker = MTP_PLATFORM_PACKAGE.toLowerCase();
  const found = findPackage(assets.packages, (name) => name.toLowerCase() === marker);
  return majorOf(found?.version);
}

/**
 * The CodeCoverage extension major compatible with an MTP platform major. Unmapped majors return
 * `undefined` on purpose: guessing is what breaks projects — an extension built against a different
 * platform major restores and compiles fine, then throws `TypeLoadException` at host startup.
 */
export function coverageExtensionMajor(platform: number | undefined): number | undefined {
  return platform === undefined ? undefined : PLATFORM_TO_COVERAGE_MAJOR[platform];
}

/** The newest version with the wanted major, from a newest-first version list. */
export function pickVersionForMajor(versions: string[], major: number): string | undefined {
  return versions.find((version) => majorOf(version) === major);
}

function majorOf(version: string | undefined): number | undefined {
  const digits = version ? /^\s*(\d+)\./.exec(version)?.[1] : undefined;
  return digits === undefined ? undefined : Number(digits);
}

/**
 * Depth-first search over the nested package graph. The visited set is global rather than per-path
 * (unlike the reader's own resolution): shared sub-graphs are common, and re-walking them turns a
 * lookup into needless work.
 */
function findPackage(
  packages: ParsedAssetPackage[],
  matches: (name: string) => boolean,
): ParsedAssetPackage | undefined {
  const stack = [...packages];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const pkg = stack.pop() as ParsedAssetPackage;
    const key = pkg.name.toLowerCase();
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    if (matches(pkg.name)) {
      return pkg;
    }
    stack.push(...pkg.dependencies);
  }
  return undefined;
}

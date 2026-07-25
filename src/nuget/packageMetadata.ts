/**
 * The display metadata a package version carries in the registration catalog, and the mapping from
 * nuget.org's raw `catalogEntry` shape onto it. Pure — no network, no vscode — so every tolerated
 * missing or oddly-typed field is testable on a literal.
 *
 * `parseVulnerabilities` is exported because search results carry the same advisory shape as
 * catalog entries; `parseSearchResponse` in `nugetApi.ts` reuses it rather than duplicating it.
 */

export interface PackageDependency {
  id: string;
  range: string;
}

export interface PackageDependencyGroup {
  /** Target framework the group applies to (empty string for the framework-agnostic group). */
  targetFramework: string;
  dependencies: PackageDependency[];
}

/** A package version the author has marked as deprecated, with the suggested way forward. */
export interface PackageDeprecation {
  /** nuget.org's reason codes, e.g. `Legacy`, `CriticalBugs`, `Other`. */
  reasons: string[];
  message?: string;
  /** The package the author points users to instead, when they named one. */
  alternatePackageId?: string;
}

/** A published security advisory affecting a package version. */
export interface PackageVulnerability {
  advisoryUrl: string;
  /** nuget.org's numeric severity: 0 low, 1 moderate, 2 high, 3 critical. */
  severity: number;
}

/** Rich, display-oriented metadata for a single package version (from the registration catalog). */
export interface PackageMetadata {
  id: string;
  version: string;
  description: string;
  summary: string;
  authors: string;
  iconUrl?: string;
  projectUrl?: string;
  /** SPDX license expression (e.g. `MIT`) when present; otherwise fall back to `licenseUrl`. */
  licenseExpression?: string;
  licenseUrl?: string;
  tags: string[];
  dependencyGroups: PackageDependencyGroup[];
  deprecation?: PackageDeprecation;
  vulnerabilities: PackageVulnerability[];
}

export interface RawCatalogEntry {
  id?: string;
  version?: string;
  description?: string;
  summary?: string;
  authors?: string | string[];
  iconUrl?: string;
  projectUrl?: string;
  licenseExpression?: string;
  licenseUrl?: string;
  tags?: string | string[];
  listed?: boolean;
  dependencyGroups?: {
    targetFramework?: string;
    dependencies?: { id?: string; range?: string }[];
  }[];
  deprecation?: {
    reasons?: string[];
    message?: string;
    alternatePackage?: { id?: string };
  };
  vulnerabilities?: { advisoryUrl?: string; severity?: number | string }[];
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return typeof value === "string" && value.trim() ? value.split(/[\s,;]+/).filter(Boolean) : [];
}

/**
 * Maps the advisory list found on a catalog entry or a search result. nuget.org has been seen to
 * serve `severity` as either a number or a numeric string, so both are accepted; entries without a
 * usable advisory URL are dropped, since the badge exists to link to the advisory.
 */
export function parseVulnerabilities(raw: { advisoryUrl?: string; severity?: number | string }[] | undefined): PackageVulnerability[] {
  return (raw ?? [])
    .filter((v): v is { advisoryUrl: string; severity?: number | string } => typeof v?.advisoryUrl === "string")
    .map((v) => ({ advisoryUrl: v.advisoryUrl, severity: Number(v.severity) || 0 }));
}

/** Maps a registration `deprecation` object, or `undefined` when the version is not deprecated. */
function parseDeprecation(raw: RawCatalogEntry["deprecation"]): PackageDeprecation | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    reasons: toStringArray(raw.reasons),
    message: typeof raw.message === "string" && raw.message ? raw.message : undefined,
    alternatePackageId: typeof raw.alternatePackage?.id === "string" ? raw.alternatePackage.id : undefined,
  };
}

/** Maps a registration `catalogEntry` object into our display metadata, tolerating missing fields. */
export function parseCatalogEntry(entry: RawCatalogEntry): PackageMetadata {
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    version: typeof entry.version === "string" ? entry.version : "",
    description: typeof entry.description === "string" ? entry.description : "",
    summary: typeof entry.summary === "string" ? entry.summary : "",
    authors: Array.isArray(entry.authors) ? entry.authors.join(", ") : (entry.authors ?? ""),
    iconUrl: typeof entry.iconUrl === "string" ? entry.iconUrl : undefined,
    projectUrl: typeof entry.projectUrl === "string" ? entry.projectUrl : undefined,
    licenseExpression:
      typeof entry.licenseExpression === "string" && entry.licenseExpression ? entry.licenseExpression : undefined,
    licenseUrl: typeof entry.licenseUrl === "string" ? entry.licenseUrl : undefined,
    tags: toStringArray(entry.tags),
    deprecation: parseDeprecation(entry.deprecation),
    vulnerabilities: parseVulnerabilities(entry.vulnerabilities),
    dependencyGroups: (entry.dependencyGroups ?? []).map((group) => ({
      targetFramework: typeof group.targetFramework === "string" ? group.targetFramework : "",
      dependencies: (group.dependencies ?? [])
        .filter((dep): dep is { id: string; range?: string } => typeof dep?.id === "string")
        .map((dep) => ({ id: dep.id, range: typeof dep.range === "string" ? dep.range : "" })),
    })),
  };
}

/**
 * Minimal client for the public nuget.org v3 APIs (no authentication). It powers the "Add Package"
 * search experience and the version pickers. Response parsing is split into pure functions so it
 * stays unit-testable without touching the network.
 */

export interface NugetPackage {
  id: string;
  version: string;
  description: string;
  totalDownloads: number;
  verified: boolean;
  iconUrl?: string;
  /** Advisories affecting the returned version — surfaced as a badge in the result list. */
  vulnerabilities: PackageVulnerability[];
}

const SERVICE_INDEX = "https://api.nuget.org/v3/index.json";
const FLAT_CONTAINER = "https://api.nuget.org/v3-flatcontainer";

interface SearchResponseItem {
  id?: string;
  version?: string;
  description?: string;
  totalDownloads?: number;
  verified?: boolean;
  iconUrl?: string;
  vulnerabilities?: { advisoryUrl?: string; severity?: number | string }[];
}

/** Maps a raw nuget search response into our package list, dropping malformed entries. */
export function parseSearchResponse(json: unknown): NugetPackage[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return (data as SearchResponseItem[])
    .filter((item): item is SearchResponseItem & { id: string } => typeof item?.id === "string")
    .map((item) => ({
      id: item.id,
      version: typeof item.version === "string" ? item.version : "",
      description: typeof item.description === "string" ? item.description : "",
      totalDownloads: typeof item.totalDownloads === "number" ? item.totalDownloads : 0,
      verified: item.verified === true,
      iconUrl: typeof item.iconUrl === "string" ? item.iconUrl : undefined,
      vulnerabilities: parseVulnerabilities(item.vulnerabilities),
    }));
}

/**
 * Finds every service-index resource whose `@type` starts with `typePrefix` and returns their URLs.
 * Discovering endpoints this way (instead of hardcoding hosts) is how official clients work and
 * survives the backing hosts (azuresearch-*, registration*) changing.
 */
export function parseServiceIndexByType(json: unknown, typePrefix: string): string[] {
  const resources = (json as { resources?: unknown })?.resources;
  if (!Array.isArray(resources)) {
    return [];
  }
  return (resources as { "@id"?: unknown; "@type"?: unknown }[])
    .filter((r) => typeof r["@type"] === "string" && (r["@type"] as string).startsWith(typePrefix))
    .map((r) => r["@id"])
    .filter((id): id is string => typeof id === "string");
}

/** Finds the SearchQueryService endpoint URLs in a NuGet service-index response. */
export function parseServiceIndex(json: unknown): string[] {
  return parseServiceIndexByType(json, "SearchQueryService");
}

/** Splits a version into its numeric core and its pre-release label (`""` for a stable release). */
function splitVersion(version: string): { core: number[]; prerelease: string } {
  const [core, ...rest] = version.split("+")[0].split("-");
  return {
    core: core.split(".").map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    }),
    prerelease: rest.join("-"),
  };
}

/**
 * Compares two dot-separated pre-release labels per SemVer: numeric identifiers compare numerically,
 * anything else lexically, a numeric identifier sorts below an alphanumeric one, and a longer label
 * wins when all shared identifiers are equal (`1.0-rc.1` < `1.0-rc.1.1`).
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const diff = parseInt(l, 10) - parseInt(r, 10);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (lNum !== rNum) {
      return lNum ? -1 : 1; // numeric identifiers always sort below alphanumeric ones
    }
    const diff = l.localeCompare(r);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Compares two NuGet version strings. Returns a negative number if `a` is older than `b`, zero if
 * equal, positive if newer. Numeric segments compare numerically, non-numeric ones count as 0, and
 * differing segment counts are length-tolerant (`9.0` == `9.0.0`). When the numeric cores match, a
 * pre-release sorts *below* the matching stable release (`9.0.0-preview.1` < `9.0.0`) — without that,
 * anyone sitting on a preview would never be offered the stable version. Build metadata (`+…`) is
 * ignored, as SemVer requires. Not a full SemVer implementation, but correct for the ordering
 * decisions made here.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease || !right.prerelease) {
    return left.prerelease ? -1 : 1; // a pre-release is older than the stable release it precedes
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Extracts the version list (newest first) from a flat-container index response. */
export function parseVersionsResponse(json: unknown): string[] {
  const versions = (json as { versions?: unknown })?.versions;
  if (!Array.isArray(versions)) {
    return [];
  }
  return versions.filter((version): version is string => typeof version === "string").reverse();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`nuget.org request failed (${response.status} ${response.statusText})`);
  }
  return response.json();
}

// Session cache of resolved service-index endpoints, keyed by resource-type prefix. A failed lookup
// is never cached, so the next call retries.
const endpointCache = new Map<string, Promise<string>>();

/** Resolves (and caches for the session) the first endpoint of `typePrefix` from the service index. */
async function getEndpoint(typePrefix: string, label: string): Promise<string> {
  let promise = endpointCache.get(typePrefix);
  if (!promise) {
    promise = (async () => {
      const endpoints = parseServiceIndexByType(await fetchJson(SERVICE_INDEX), typePrefix);
      if (endpoints.length === 0) {
        throw new Error(`nuget.org did not advertise a ${label} endpoint.`);
      }
      return endpoints[0];
    })().catch((err) => {
      endpointCache.delete(typePrefix);
      throw err;
    });
    endpointCache.set(typePrefix, promise);
  }
  return promise;
}

const getSearchEndpoint = (): Promise<string> => getEndpoint("SearchQueryService", "search");
// The gzipped, SemVer 2.0.0 registration base is the richest; Node's fetch decompresses it transparently.
const getRegistrationsBase = (): Promise<string> => getEndpoint("RegistrationsBaseUrl/3.6.0", "registrations");

export async function searchPackages(
  query: string,
  options: { prerelease?: boolean; take?: number } = {},
): Promise<NugetPackage[]> {
  const endpoint = await getSearchEndpoint();
  const params = new URLSearchParams({
    q: query,
    take: String(options.take ?? 20),
    prerelease: String(options.prerelease ?? false),
    semVerLevel: "2.0.0",
  });
  return parseSearchResponse(await fetchJson(`${endpoint}?${params.toString()}`));
}

export async function getPackageVersions(id: string, options: { prerelease?: boolean } = {}): Promise<string[]> {
  const versions = parseVersionsResponse(await fetchJson(`${FLAT_CONTAINER}/${id.toLowerCase()}/index.json`));
  // A `-` suffix marks a pre-release version (e.g. 9.0.0-preview.1); hide those unless asked for.
  return options.prerelease ? versions : versions.filter((version) => !version.includes("-"));
}

// Session cache of latest-stable lookups, keyed by lowercased package id. Like `endpointCache` this
// stores the *promise*, so concurrent lookups of the same id share one request, and drops the entry
// on rejection so a transient failure isn't remembered for the rest of the session.
const latestStableCache = new Map<string, Promise<string | undefined>>();

/**
 * The newest stable version of a package, or `undefined` when it has no stable release / is unknown.
 * Cached for the session: a package's newest release does not change while VS Code is open, and the
 * update check asks for the same ids on every refresh.
 */
export function getLatestStableVersion(id: string): Promise<string | undefined> {
  const key = id.toLowerCase();
  let promise = latestStableCache.get(key);
  if (!promise) {
    promise = getPackageVersions(id)
      .then((versions) => versions[0])
      .catch((err: unknown) => {
        latestStableCache.delete(key);
        throw err;
      });
    latestStableCache.set(key, promise);
  }
  return promise;
}

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

interface RawCatalogEntry {
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
function parseVulnerabilities(raw: { advisoryUrl?: string; severity?: number | string }[] | undefined): PackageVulnerability[] {
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

interface RegistrationPage {
  "@id"?: string;
  /** Inclusive version range this page covers; present on the index, absent on a fetched page. */
  lower?: string;
  upper?: string;
  items?: { catalogEntry?: RawCatalogEntry }[];
}

/**
 * Picks the catalog entry for `wantedVersion` (or the newest listed entry when omitted) out of a
 * registration index's pages. Only pages with inline `items` are considered here; the caller fetches
 * a non-inline page separately. Returns the matching raw entry, or `undefined`.
 */
export function pickCatalogEntry(
  pages: RegistrationPage[],
  wantedVersion?: string,
): RawCatalogEntry | undefined {
  const entries: RawCatalogEntry[] = [];
  for (const page of pages) {
    for (const leaf of page.items ?? []) {
      if (leaf.catalogEntry) {
        entries.push(leaf.catalogEntry);
      }
    }
  }
  if (wantedVersion) {
    return entries.find((e) => e.version?.toLowerCase() === wantedVersion.toLowerCase());
  }
  const listed = entries.filter((e) => e.listed !== false && !(e.version ?? "").includes("-"));
  const pool = listed.length > 0 ? listed : entries;
  return pool.reduce<RawCatalogEntry | undefined>(
    (best, e) => (!best || compareVersions(e.version ?? "", best.version ?? "") > 0 ? e : best),
    undefined,
  );
}

/**
 * Orders an index's pages by how likely they are to hold `wantedVersion`, best first.
 *
 * This ordering is what makes paginated indexes work. Every popular package is paginated and, on
 * nuget.org, *no* page carries inline items — so a naive front-to-back walk lands on the oldest page
 * and reports metadata for an ancient version. Each page advertises the `lower`/`upper` version range
 * it covers, so a page whose range contains the wanted version is tried first; with no version asked
 * for, the newest page (highest `upper`) wins. Pages without bounds are kept as a last resort rather
 * than dropped, since the caller can still scan them.
 */
export function orderPagesForVersion(pages: RegistrationPage[], wantedVersion?: string): RegistrationPage[] {
  const rank = (page: RegistrationPage): number => {
    if (!wantedVersion) {
      return 0;
    }
    const { lower, upper } = page;
    if (lower && upper && compareVersions(wantedVersion, lower) >= 0 && compareVersions(wantedVersion, upper) <= 0) {
      return -1; // the page whose range covers the wanted version
    }
    return 0;
  };
  return [...pages].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) {
      return byRank;
    }
    // Newest page first: the latest release lives at the top of the highest range.
    return compareVersions(b.upper ?? "0.0.0", a.upper ?? "0.0.0");
  });
}

/** How many registration pages to fetch before giving up — bounds the work on a huge version history. */
const MAX_REGISTRATION_PAGE_FETCHES = 4;

/**
 * Loads display metadata for a package from the registration API. When `version` is omitted the
 * newest listed stable version is used. Pages are visited most-promising-first (see
 * `orderPagesForVersion`) and fetched on demand when they only advertise an `@id`.
 */
export async function getPackageMetadata(id: string, version?: string): Promise<PackageMetadata | undefined> {
  const base = await getRegistrationsBase();
  const index = (await fetchJson(`${base}${id.toLowerCase()}/index.json`)) as { items?: RegistrationPage[] };

  let fetches = 0;
  for (const page of orderPagesForVersion(index.items ?? [], version)) {
    let candidate = page;
    if (!candidate.items) {
      if (!candidate["@id"] || fetches >= MAX_REGISTRATION_PAGE_FETCHES) {
        continue;
      }
      fetches++;
      candidate = (await fetchJson(candidate["@id"])) as RegistrationPage;
    }
    const entry = pickCatalogEntry([candidate], version);
    if (entry) {
      return parseCatalogEntry(entry);
    }
  }
  return undefined;
}

/**
 * Fetches a package version's raw README markdown, or `undefined` when the package ships none
 * (the flat-container README endpoint 404s in that case).
 */
export async function getPackageReadme(id: string, version: string): Promise<string | undefined> {
  const response = await fetch(`${FLAT_CONTAINER}/${id.toLowerCase()}/${version.toLowerCase()}/readme`);
  if (!response.ok) {
    return undefined;
  }
  return response.text();
}

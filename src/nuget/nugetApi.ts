/**
 * Minimal client for the public nuget.org v3 APIs (no authentication). It powers the "Add Package"
 * search experience and the version pickers. Everything network-facing lives here; the response
 * parsing it builds on is pure and sits in `packageMetadata.ts` / `registrationPages.ts`, the host
 * lookup in `nugetEndpoints.ts` and the version ordering in `versionCompare.ts`.
 */

import {
  fetchJson,
  FLAT_CONTAINER,
  getRegistrationsBase,
  getSearchEndpoint,
} from "./nugetEndpoints.js";
import {
  parseCatalogEntry,
  parseVulnerabilities,
  PackageMetadata,
  PackageVulnerability,
} from "./packageMetadata.js";
import { orderPagesForVersion, pickCatalogEntry, RegistrationPage } from "./registrationPages.js";

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

/** Extracts the version list (newest first) from a flat-container index response. */
export function parseVersionsResponse(json: unknown): string[] {
  const versions = (json as { versions?: unknown })?.versions;
  if (!Array.isArray(versions)) {
    return [];
  }
  return versions.filter((version): version is string => typeof version === "string").reverse();
}

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

// Session cache of latest-stable lookups, keyed by lowercased package id. Like the endpoint cache in
// `nugetEndpoints.ts` this stores the *promise*, so concurrent lookups of the same id share one
// request, and drops the entry on rejection so a transient failure isn't remembered for the rest of
// the session.
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

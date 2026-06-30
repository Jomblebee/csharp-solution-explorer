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
}

const SERVICE_INDEX = "https://api.nuget.org/v3/index.json";
const FLAT_CONTAINER = "https://api.nuget.org/v3-flatcontainer";

interface SearchResponseItem {
  id?: string;
  version?: string;
  description?: string;
  totalDownloads?: number;
  verified?: boolean;
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
    }));
}

/**
 * Finds the SearchQueryService endpoint URLs in a NuGet service-index response. Discovering the
 * endpoint this way (instead of hardcoding a host) is how official clients work and survives the
 * azuresearch-* hosts changing.
 */
export function parseServiceIndex(json: unknown): string[] {
  const resources = (json as { resources?: unknown })?.resources;
  if (!Array.isArray(resources)) {
    return [];
  }
  return (resources as { "@id"?: unknown; "@type"?: unknown }[])
    .filter((r) => typeof r["@type"] === "string" && (r["@type"] as string).startsWith("SearchQueryService"))
    .map((r) => r["@id"])
    .filter((id): id is string => typeof id === "string");
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

let searchEndpointPromise: Promise<string> | undefined;

/** Resolves (and caches for the session) the SearchQueryService endpoint from the service index. */
async function getSearchEndpoint(): Promise<string> {
  if (!searchEndpointPromise) {
    searchEndpointPromise = (async () => {
      const endpoints = parseServiceIndex(await fetchJson(SERVICE_INDEX));
      if (endpoints.length === 0) {
        throw new Error("nuget.org did not advertise a search endpoint.");
      }
      return endpoints[0];
    })().catch((err) => {
      // Don't cache a failed lookup — let the next search retry.
      searchEndpointPromise = undefined;
      throw err;
    });
  }
  return searchEndpointPromise;
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

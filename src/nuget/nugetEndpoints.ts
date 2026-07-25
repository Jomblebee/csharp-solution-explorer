/**
 * Reaching nuget.org: the service-index lookup that resolves the API hosts, plus the JSON fetch
 * helper every call goes through. The only module in `src/nuget/` that talks to the network for
 * JSON, so the parsers above it stay testable without touching it.
 */

const SERVICE_INDEX = "https://api.nuget.org/v3/index.json";
export const FLAT_CONTAINER = "https://api.nuget.org/v3-flatcontainer";

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

export async function fetchJson(url: string): Promise<unknown> {
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

export const getSearchEndpoint = (): Promise<string> => getEndpoint("SearchQueryService", "search");
// The gzipped, SemVer 2.0.0 registration base is the richest; Node's fetch decompresses it transparently.
export const getRegistrationsBase = (): Promise<string> => getEndpoint("RegistrationsBaseUrl/3.6.0", "registrations");

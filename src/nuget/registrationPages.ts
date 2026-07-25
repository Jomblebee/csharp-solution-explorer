/**
 * Finding the right catalog entry inside a registration index. The index is paginated and the pages
 * are ordered oldest-first, so picking the page to look at is its own decision — kept here, pure and
 * testable, apart from the fetching in `nugetApi.ts`.
 */

import { RawCatalogEntry } from "./packageMetadata.js";
import { compareVersions } from "./versionCompare.js";

export interface RegistrationPage {
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

// Detection of NuGet Central Package Management (CPM). Under CPM the versions live in a shared
// `Directory.Packages.props` as `<PackageVersion>` elements and the projects reference packages
// without a version. `dotnet add package --version` would then write a version into the .csproj that
// does not belong there, so the manager needs to know and say so rather than quietly do the wrong
// thing. Parsing is pure text (same regex approach as csprojReader), so it stays unit-testable.

/** The name MSBuild looks for when walking up from a project directory. */
export const PACKAGES_PROPS_FILENAME = "Directory.Packages.props";

export interface CentralPackageVersion {
  name: string;
  version?: string;
}

export interface PackagesPropsInfo {
  /** True only when `ManagePackageVersionsCentrally` is explicitly enabled. */
  enabled: boolean;
  versions: CentralPackageVersion[];
}

const PACKAGE_VERSION_TAG_PATTERN = /<PackageVersion\b([^>]*?)\/?>/gi;
const MANAGE_CENTRALLY_PATTERN = /<ManagePackageVersionsCentrally\s*>([^<]*)<\/ManagePackageVersionsCentrally\s*>/i;

function getAttribute(attributes: string, attributeName: string): string | undefined {
  return new RegExp(`${attributeName}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)?.[1];
}

/**
 * Parses a `Directory.Packages.props`. CPM counts as enabled only when the property is present and
 * true — the file existing is not enough, since a repo may keep one around with the flag turned off.
 */
export function parsePackagesProps(text: string): PackagesPropsInfo {
  const enabled = MANAGE_CENTRALLY_PATTERN.exec(text)?.[1].trim().toLowerCase() === "true";
  const versions: CentralPackageVersion[] = [];
  for (const match of text.matchAll(PACKAGE_VERSION_TAG_PATTERN)) {
    const name = getAttribute(match[1], "Include");
    if (name) {
      versions.push({ name, version: getAttribute(match[1], "Version") });
    }
  }
  return { enabled, versions };
}

/** One directory MSBuild would look in, with the props file's text (`undefined` when absent). */
export interface PropsCandidate {
  dir: string;
  text: string | undefined;
}

export interface CentralPackageManagementInfo {
  /** POSIX path of the governing props file, for the panel to name in its banner. */
  propsPath: string;
  versions: CentralPackageVersion[];
}

/**
 * Decides whether a project is centrally managed, given the candidate directories nearest-first
 * (see `ancestorDirectories`). The *first* directory that actually has the file decides: MSBuild
 * imports exactly one `Directory.Packages.props`, so a file with the flag turned off means "not
 * centrally managed" rather than "keep looking" — an enabled file further up would never be read.
 *
 * Kept free of the filesystem so the precedence rules stay unit-testable; the caller supplies the
 * file contents.
 */
export function decideCentralPackageManagement(
  candidates: readonly PropsCandidate[],
): CentralPackageManagementInfo | undefined {
  for (const candidate of candidates) {
    if (candidate.text === undefined) {
      continue;
    }
    const props = parsePackagesProps(candidate.text);
    return props.enabled
      ? { propsPath: `${candidate.dir}/${PACKAGES_PROPS_FILENAME}`, versions: props.versions }
      : undefined;
  }
  return undefined;
}

/**
 * The directories MSBuild would search for `Directory.Packages.props`, starting at `startDir` and
 * walking up to the filesystem root. Returned as directories rather than full paths so the caller
 * decides how to join and read them (and stays the only part that touches the FS).
 *
 * Paths are compared with forward slashes internally, matching the rest of the codebase.
 */
export function ancestorDirectories(startDir: string): string[] {
  const directories: string[] = [];
  let current = startDir.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  // The `includes` guard terminates at a root that is its own parent (`/`); path depth is small
  // enough that the linear scan costs nothing.
  while (current && !directories.includes(current)) {
    directories.push(current);
    const slash = current.lastIndexOf("/");
    if (slash < 0) {
      break; // a bare drive letter (`C:`) or a single relative segment — no parent left
    }
    current = slash === 0 ? "/" : current.slice(0, slash);
  }
  return directories;
}

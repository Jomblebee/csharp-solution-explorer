import * as path from "node:path";
import { minimatch } from "minimatch";

const PROJECT_EXTENSIONS = new Set([".csproj", ".fsproj", ".vbproj"]);

export function isLikelyCsproj(filePath: string): boolean {
  return PROJECT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getProjectRootDir(csprojPath: string): string {
  return path.dirname(csprojPath);
}

export interface CsprojPackageReference {
  name: string;
  version?: string;
}

export interface CsprojProjectReference {
  relativePath: string;
}

export interface CsprojFrameworkReference {
  name: string;
}

export interface CsprojAnalyzer {
  name: string;
}

const PACKAGE_REFERENCE_TAG_PATTERN = /<PackageReference\b([^>]*?)\/?>/gi;
const PROJECT_REFERENCE_TAG_PATTERN = /<ProjectReference\b([^>]*?)\/?>/gi;
const FRAMEWORK_REFERENCE_TAG_PATTERN = /<FrameworkReference\b([^>]*?)\/?>/gi;
const ANALYZER_TAG_PATTERN = /<Analyzer\b([^>]*?)\/?>/gi;
const PROJECT_SDK_ATTRIBUTE_PATTERN = /<Project\b[^>]*?\bSdk\s*=\s*"([^"]*)"/i;

function getAttribute(attributes: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*"([^"]*)"`, "i");
  return pattern.exec(attributes)?.[1];
}

/**
 * Parses `<PackageReference Include="X" Version="Y" />` elements from a .csproj file's
 * text content. `Version` is optional since it's omitted under central package management.
 */
export function parsePackageReferences(csprojText: string): CsprojPackageReference[] {
  const results: CsprojPackageReference[] = [];

  for (const match of csprojText.matchAll(PACKAGE_REFERENCE_TAG_PATTERN)) {
    const attributes = match[1];
    const name = getAttribute(attributes, "Include");
    if (!name) {
      continue;
    }
    results.push({ name, version: getAttribute(attributes, "Version") });
  }

  return results;
}

/**
 * Parses `<ProjectReference Include="../Foo/Foo.csproj" />` elements from a .csproj file's
 * text content. Relative paths are normalized from Windows-style backslashes to forward slashes.
 */
export function parseProjectReferences(csprojText: string): CsprojProjectReference[] {
  const results: CsprojProjectReference[] = [];

  for (const match of csprojText.matchAll(PROJECT_REFERENCE_TAG_PATTERN)) {
    const relativePath = getAttribute(match[1], "Include");
    if (!relativePath) {
      continue;
    }
    results.push({ relativePath: relativePath.replace(/\\/g, "/") });
  }

  return results;
}

/**
 * Reads the `Sdk` attribute of the root `<Project Sdk="...">` element, e.g. `Microsoft.NET.Sdk`
 * or `Microsoft.NET.Sdk.Web`. Returns undefined for non-SDK-style projects.
 */
export function parseSdkAttribute(csprojText: string): string | undefined {
  return PROJECT_SDK_ATTRIBUTE_PATTERN.exec(csprojText)?.[1];
}

/**
 * Parses the target framework moniker(s) of a project: the single `<TargetFramework>` (e.g.
 * `net8.0`) or the semicolon-delimited `<TargetFrameworks>` (e.g. `net8.0;net9.0`). Returns the
 * raw TFM tokens in document order; callers filter out non-`net<major>.0` monikers and unresolved
 * MSBuild variables (`$(...)`) themselves.
 */
export function parseTargetFrameworks(csprojText: string): string[] {
  const single = getPropertyValue(csprojText, "TargetFramework");
  const multiple = getPropertyValue(csprojText, "TargetFrameworks");
  const raw = multiple ?? single ?? "";
  return raw
    .split(";")
    .map((tfm) => tfm.trim())
    .filter((tfm) => tfm.length > 0);
}

/**
 * Parses the `<OutputType>` element (e.g. `Exe`, `WinExe`, `Library`). Returns undefined when
 * not set explicitly, which means the SDK's own default applies.
 */
export function parseOutputType(csprojText: string): string | undefined {
  return getPropertyValue(csprojText, "OutputType");
}

const TEST_PACKAGE_MARKERS = ["microsoft.net.test.sdk", "xunit", "nunit", "mstest"];

/**
 * Best-effort "is this a unit-test project" classification, without invoking MSBuild. True when
 * `<IsTestProject>true</IsTestProject>` is set, or a `PackageReference` names a known test SDK or
 * framework (Microsoft.NET.Test.Sdk, xUnit, NUnit, MSTest). Test projects default to
 * `OutputType=Library`, so this is the only way to tell them apart from plain class libraries.
 */
export function isTestProject(csprojText: string): boolean {
  if (getPropertyValue(csprojText, "IsTestProject")?.toLowerCase() === "true") {
    return true;
  }
  return parsePackageReferences(csprojText).some((reference) => {
    const name = reference.name.toLowerCase();
    return TEST_PACKAGE_MARKERS.some((marker) => name.includes(marker));
  });
}

/**
 * Best-effort "can this project be run/debugged" classification, without invoking MSBuild.
 * An explicit `OutputType` always wins; otherwise the SDK's implicit default is used —
 * `Microsoft.NET.Sdk.Web` and `Microsoft.NET.Sdk.BlazorWebAssembly` projects default to an
 * executable output, every other SDK (plain class libraries, test projects) defaults to a
 * library.
 */
export function isDebuggableProject(sdk: string | undefined, outputType: string | undefined): boolean {
  const normalizedOutputType = outputType?.trim().toLowerCase();
  if (normalizedOutputType === "exe" || normalizedOutputType === "winexe") {
    return true;
  }
  if (normalizedOutputType === "library" || normalizedOutputType === "module") {
    return false;
  }
  const normalizedSdk = sdk?.toLowerCase() ?? "";
  return normalizedSdk.includes("sdk.web") || normalizedSdk.includes("sdk.blazorwebassembly");
}

/**
 * Whether an `Sdk` attribute denotes a web-shaped project (ASP.NET Core, Razor, or Blazor) — used to
 * offer web-specific launch options (URLs, browser) only where they make sense.
 */
export function isWebSdk(sdk: string | undefined): boolean {
  const normalized = sdk?.toLowerCase() ?? "";
  return normalized.includes("web") || normalized.includes("razor") || normalized.includes("blazor");
}

/**
 * Parses explicit `<FrameworkReference Include="Microsoft.AspNetCore.App" />` elements.
 */
export function parseFrameworkReferences(csprojText: string): CsprojFrameworkReference[] {
  const results: CsprojFrameworkReference[] = [];

  for (const match of csprojText.matchAll(FRAMEWORK_REFERENCE_TAG_PATTERN)) {
    const name = getAttribute(match[1], "Include");
    if (name) {
      results.push({ name });
    }
  }

  return results;
}

/**
 * Parses explicit `<Analyzer Include="path/to/Foo.dll" />` elements, surfacing the assembly's
 * file name (without extension) as the display name.
 */
export function parseAnalyzers(csprojText: string): CsprojAnalyzer[] {
  const results: CsprojAnalyzer[] = [];

  for (const match of csprojText.matchAll(ANALYZER_TAG_PATTERN)) {
    const include = getAttribute(match[1], "Include");
    if (include) {
      const fileName = include.replace(/\\/g, "/").split("/").pop() ?? include;
      results.push({ name: fileName.replace(/\.dll$/i, "") });
    }
  }

  return results;
}

/**
 * The shared framework(s) implied by a project's `Sdk` attribute, used as a best-effort
 * "Frameworks" list when no `project.assets.json` is available. `Microsoft.NETCore.App` is the
 * base shared framework for every SDK-style project; web/Razor SDKs add `Microsoft.AspNetCore.App`.
 */
export function deriveImplicitFrameworks(sdk: string | undefined): string[] {
  if (!sdk) {
    return [];
  }
  const frameworks = ["Microsoft.NETCore.App"];
  const normalized = sdk.toLowerCase();
  if (normalized.includes("sdk.web") || normalized.includes("sdk.razor")) {
    frameworks.push("Microsoft.AspNetCore.App");
  }
  return frameworks;
}

export type CsprojItemType = "Compile" | "None" | "Content";

export interface ItemRule {
  itemType: CsprojItemType;
  attribute: "Include" | "Remove" | "Exclude";
  /** A single glob pattern (semicolon-delimited lists are split into one rule each), normalized to forward slashes. */
  pattern: string;
}

const ITEM_TYPES: readonly CsprojItemType[] = ["Compile", "None", "Content"];
const ITEM_ATTRIBUTES = ["Include", "Remove", "Exclude"] as const;

const ENABLE_DEFAULT_ITEMS_TAG = "EnableDefaultItems";
const ENABLE_DEFAULT_ITEM_TYPE_TAG: Record<CsprojItemType, string> = {
  Compile: "EnableDefaultCompileItems",
  None: "EnableDefaultNoneItems",
  Content: "EnableDefaultContentItems",
};

function getPropertyValue(csprojText: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, "i");
  return pattern.exec(csprojText)?.[1].trim();
}

/**
 * Parses `<Compile/None/Content Include=/Remove=/Exclude= />` elements from a .csproj file's
 * text content, preserving document order (within each item type) so that later explicit
 * `Include` rules can be recognized as re-including files removed by an earlier `Remove`/`Exclude`.
 */
export function parseItemRules(csprojText: string): ItemRule[] {
  const results: ItemRule[] = [];

  for (const itemType of ITEM_TYPES) {
    const tagPattern = new RegExp(`<${itemType}\\b([^>]*?)\\/?>`, "gi");
    for (const match of csprojText.matchAll(tagPattern)) {
      const attributes = match[1];
      for (const attribute of ITEM_ATTRIBUTES) {
        const value = getAttribute(attributes, attribute);
        if (!value) {
          continue;
        }
        for (const pattern of value.split(";")) {
          const trimmed = pattern.trim();
          if (trimmed) {
            results.push({ itemType, attribute, pattern: trimmed.replace(/\\/g, "/") });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Whether the SDK's implicit default glob (e.g. `**\/*.cs` for Compile) applies to the given
 * item type, honoring both the per-type switch (`EnableDefaultCompileItems`, etc.) and the
 * project-wide `EnableDefaultItems` master switch. Defaults to `true` when neither is set.
 */
export function isImplicitItemGlobEnabled(csprojText: string, itemType: CsprojItemType): boolean {
  if (getPropertyValue(csprojText, ENABLE_DEFAULT_ITEMS_TAG)?.toLowerCase() === "false") {
    return false;
  }
  return getPropertyValue(csprojText, ENABLE_DEFAULT_ITEM_TYPE_TAG[itemType])?.toLowerCase() !== "false";
}

/**
 * Resolves which of `allRelativePaths` (POSIX-relative to the project root) are excluded from
 * the given item type, given the parsed rules and whether the SDK implicit glob applies.
 *
 * Uses a simplified two-pass model rather than exact MSBuild per-element document-order
 * evaluation: all explicit Includes are applied, then all Remove/Exclude rules win over them,
 * then any Include rule positioned after the last Remove/Exclude rule (in document order)
 * is treated as a re-include. This covers the common "default glob plus a few Remove globs"
 * pattern without fully modeling interleaved per-element MSBuild evaluation order.
 */
export function resolveExcludedPaths(
  rules: ItemRule[],
  itemType: CsprojItemType,
  allRelativePaths: string[],
  implicitGlobEnabled: boolean,
): Set<string> {
  const typeRules = rules.filter((rule) => rule.itemType === itemType);
  const included = new Set<string>(implicitGlobEnabled ? allRelativePaths : []);

  const matchesAny = (pattern: string) => allRelativePaths.filter((p) => minimatch(p, pattern, { dot: false }));

  for (const rule of typeRules) {
    if (rule.attribute === "Include") {
      for (const path of matchesAny(rule.pattern)) {
        included.add(path);
      }
    }
  }

  let lastRemoveIndex = -1;
  typeRules.forEach((rule, index) => {
    if (rule.attribute === "Remove" || rule.attribute === "Exclude") {
      lastRemoveIndex = index;
    }
  });

  for (const rule of typeRules) {
    if (rule.attribute === "Remove" || rule.attribute === "Exclude") {
      for (const path of matchesAny(rule.pattern)) {
        included.delete(path);
      }
    }
  }

  typeRules.forEach((rule, index) => {
    if (index > lastRemoveIndex && rule.attribute === "Include") {
      for (const path of matchesAny(rule.pattern)) {
        included.add(path);
      }
    }
  });

  return new Set(allRelativePaths.filter((path) => !included.has(path)));
}

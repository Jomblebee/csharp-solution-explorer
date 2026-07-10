// Pure helpers describing where the Roslyn language server comes from and how it is laid out.
// No `vscode`/IO imports so the URL/path logic stays unit-testable; the actual download and
// extraction live in `roslynDownloader.ts`.

import { Rid } from "./rid.js";

/**
 * The Microsoft.CodeAnalysis.LanguageServer version this extension is pinned to. Deliberately fixed
 * (not "latest") so behaviour is reproducible and the daily-moving feed can't break users. Confirmed
 * available for win-x64/linux-x64/osx-x64/osx-arm64/neutral. Overridable via the
 * `csharpSolutionExplorer.languageServer.version` setting.
 */
export const ROSLYN_LS_VERSION = "5.4.0-2.26080.13";

/**
 * Public, unauthenticated Azure DevOps NuGet v3 feed that hosts the Roslyn language server packages
 * (the same `vs-impl` feed the official tooling restores from).
 */
export const ROSLYN_FEED_INDEX =
  "https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json";

/** NuGet package id for a RID-specific, self-contained server build (canonical casing). */
export function packageId(rid: Rid): string {
  return `Microsoft.CodeAnalysis.LanguageServer.${rid}`;
}

/** Flat-container (PackageBaseAddress) URLs address packages by their lowercased id. */
function packageIdLower(rid: Rid): string {
  return packageId(rid).toLowerCase();
}

export function nupkgFileName(rid: Rid, version: string): string {
  return `${packageIdLower(rid)}.${version}.nupkg`;
}

/**
 * Builds the direct `.nupkg` download URL from a PackageBaseAddress (flat container) base:
 * `{base}/{id-lower}/{version}/{id-lower}.{version}.nupkg`.
 */
export function nupkgUrl(baseAddress: string, rid: Rid, version: string): string {
  const base = baseAddress.endsWith("/") ? baseAddress : `${baseAddress}/`;
  return `${base}${packageIdLower(rid)}/${version}/${nupkgFileName(rid, version)}`;
}

/**
 * Extracts the PackageBaseAddress ("flat container") endpoint from a NuGet v3 service index — the
 * resource we download `.nupkg` files from. Discovering it from the index (rather than hardcoding a
 * host) mirrors how `nugetApi.parseServiceIndex` finds the search endpoint and survives host changes.
 */
export function parsePackageBaseAddress(json: unknown): string | undefined {
  const resources = (json as { resources?: unknown })?.resources;
  if (!Array.isArray(resources)) {
    return undefined;
  }
  const match = (resources as { "@id"?: unknown; "@type"?: unknown }[]).find(
    (r) => typeof r["@type"] === "string" && (r["@type"] as string).startsWith("PackageBaseAddress"),
  );
  return match && typeof match["@id"] === "string" ? (match["@id"] as string) : undefined;
}

export interface ServerEntry {
  /** Path to the server executable/DLL, relative to the extracted RID directory. */
  relPath: string;
  /** How to launch it: a native apphost ("exe") or a framework-dependent DLL via `dotnet exec` ("dll"). */
  kind: "exe" | "dll";
}

/**
 * The server entry point inside a RID's extracted folder. Windows ships a native `.exe` launcher and
 * Linux a native apphost with no extension; both still require an installed .NET runtime (the
 * packages are ReadyToRun but framework-dependent). macOS is launched via `dotnet exec` on the
 * `.dll`: the downloaded native apphost would be Gatekeeper-quarantined (unsigned), so we avoid it —
 * matching the reference implementations. macOS therefore requires the `dotnet` CLI on PATH.
 */
export function serverEntry(rid: Rid): ServerEntry {
  if (rid.startsWith("win-")) {
    return { relPath: "Microsoft.CodeAnalysis.LanguageServer.exe", kind: "exe" };
  }
  if (rid.startsWith("osx-")) {
    return { relPath: "Microsoft.CodeAnalysis.LanguageServer.dll", kind: "dll" };
  }
  return { relPath: "Microsoft.CodeAnalysis.LanguageServer", kind: "exe" };
}

/** The path prefix inside the `.nupkg` ZIP that holds a RID's server files. */
export function packageContentPrefix(rid: Rid): string {
  return `content/LanguageServer/${rid}/`;
}

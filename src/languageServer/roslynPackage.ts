// Pure helpers describing where the Roslyn language server comes from and how it is laid out.
// No `vscode`/IO imports so the URL/path logic stays unit-testable; the actual download and
// extraction live in `roslynDownloader.ts`.

import * as path from "node:path";
import { Rid } from "./rid.js";

/**
 * The Roslyn language server version this extension is pinned to. Deliberately fixed (not "latest")
 * so behaviour is reproducible and the moving feed can't break users. This is the exact build the
 * official `dotnet/vscode-csharp` extension pins (`defaults.roslyn`), confirmed available for all
 * supported RIDs on the Azure `msft_consumption` feed (see `ROSLYN_FEED_INDEX`). Overridable via the
 * `csharpSolutionExplorer.languageServer.version` setting.
 *
 * This is on the `5.10` line, where Razor is a *built-in* feature of the server (dotnet/vscode-csharp
 * PR #9277): the Razor service ships inside this package and the server auto-loads it, so Razor cohosting
 * works out of the box (nuget.org tops out at `5.9`, before this landed — hence the feed switch). See
 * `RazorLaunch` in `roslynServer.ts` for why we must NOT pass the Razor extension via `--extension`.
 */
export const ROSLYN_LS_VERSION = "5.10.0-1.26359.5";

/**
 * The oldest Roslyn server build that actually *routes* `.razor`/`.cshtml` to the Razor cohost
 * handlers. Earlier builds carry the `ExternalAccess.Razor` shims and will load the `--extension`, but
 * they mis-route Razor requests to their C# handlers (which then fail with "Attempted to retrieve a
 * Document but a TextDocument was found instead"). Our pinned `ROSLYN_LS_VERSION` is above this line.
 *
 * The gate still matters for the `serverPath`/`version` overrides: if a user points us at an older
 * server (e.g. `5.5.0-2.x`, also on the feed), Razor cleanly falls back to highlighting-only instead
 * of flooding an incompatible server with failing requests. Source: roslyn.nvim ("supports razor
 * since 5.8.0-1.26262.10").
 */
export const RAZOR_COHOST_MIN_SERVER_VERSION = "5.8.0-1.26262.10";

/**
 * Whether a Roslyn server `version` is new enough to route Razor to the cohost handlers (see
 * `RAZOR_COHOST_MIN_SERVER_VERSION`). Roslyn runs several parallel release lines (`4.x`, `5.4.0-2.x`,
 * `5.8.0-1.x`, `5.10.0-1.x`) whose build dates overlap, so we compare the release line (major.minor)
 * first and only use the build date within the `5.8` line — a newer build date on an *older* line
 * (e.g. `4.14.0-3.26358.x`) does not imply cohost support. Unparseable versions are treated as
 * incapable (fail safe to highlighting-only).
 */
export function serverSupportsRazorCohost(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.\d+-\d+\.(\d+)\.\d+$/.exec(version.trim());
  if (!m) {
    return false;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const build = Number(m[3]);
  if (major !== 5) {
    return major > 5;
  }
  if (minor !== 8) {
    return minor > 8;
  }
  return build >= 26262;
}

/**
 * NuGet v3 service index for the RID-specific `roslyn-language-server.{rid}` packages (Microsoft,
 * built from dotnet/roslyn, MIT — the official .NET tool packages that bundle the Razor cohost
 * service). We use the anonymously-readable Azure `azure-public/vside` feeds rather than nuget.org:
 * nuget.org caps this package at `5.9`, whereas `msft_consumption` (the feed in vscode-csharp's own
 * NuGet.config) carries the `5.10` built-in-Razor builds. `vs-impl` (used by the roslyn.nvim plugins)
 * mirrors the same packages and serves as a fallback.
 *
 * Only the service index is hardcoded; the flat-container (PackageBaseAddress) URL — whose GUIDs are
 * feed-specific — is always discovered from the index via `parsePackageBaseAddress`, never hardcoded.
 */
export const ROSLYN_FEED_INDEX =
  "https://pkgs.dev.azure.com/azure-public/vside/_packaging/msft_consumption/nuget/v3/index.json";

/** Fallback feed (roslyn.nvim's `vs-impl`), tried if `ROSLYN_FEED_INDEX` is unreachable. */
export const ROSLYN_FEED_INDEX_FALLBACK =
  "https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json";

// Cache pruning is shared with the debug adapter download, which has the same
// `<root>/<version>/<rid>` layout. Re-exported here so existing callers and tests are unaffected.
export { versionsToPrune } from "../shared/versionedCache.js";

/**
 * Tries `feeds` in order with `fetchIndex`, returning the first that resolves. Pure orchestration (no
 * IO/`vscode`) so the fallback ordering stays unit-testable; the real fetch+parse lives in
 * `roslynDownloader.ts`. If every feed fails, the *first* error is rethrown so the caller can wrap it
 * (e.g. in `FeedUnreachableError`) with the primary feed's cause.
 */
export async function resolveBaseAddressFrom(
  feeds: readonly string[],
  fetchIndex: (url: string) => Promise<string>,
): Promise<string> {
  let firstError: unknown;
  for (const url of feeds) {
    try {
      return await fetchIndex(url);
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error("No C# language server feeds were configured.");
}

/**
 * NuGet package id for a RID-specific server build. `roslyn-language-server.{rid}` is Microsoft's
 * official .NET tool package (it bundles the server binary and the Razor cohost bits under `Targets/`
 * next to it); on the Azure `azure-public/vside` feeds it serves the current `5.10` built-in-Razor builds.
 */
export function packageId(rid: Rid): string {
  return `roslyn-language-server.${rid}`;
}

/** Flat-container (PackageBaseAddress) URLs address packages by their lowercased id. */
function packageIdLower(rid: Rid): string {
  return packageId(rid).toLowerCase();
}

export function nupkgFileName(rid: Rid, version: string): string {
  return `${packageIdLower(rid)}.${version}.nupkg`;
}

/**
 * Builds a direct `.nupkg` download URL from a PackageBaseAddress (flat container) base and a
 * lowercased package id: `{base}/{id-lower}/{version}/{id-lower}.{version}.nupkg`.
 */
export function flatContainerNupkgUrl(baseAddress: string, idLower: string, version: string): string {
  const base = baseAddress.endsWith("/") ? baseAddress : `${baseAddress}/`;
  return `${base}${idLower}/${version}/${idLower}.${version}.nupkg`;
}

/** The direct `.nupkg` URL for a RID-specific Roslyn language server build. */
export function nupkgUrl(baseAddress: string, rid: Rid, version: string): string {
  return flatContainerNupkgUrl(baseAddress, packageIdLower(rid), version);
}

/** Absolute paths to the Razor cohost files, passed to Roslyn to enable cohosting (both in `serverDir`). */
export interface RazorLaunchPaths {
  /** `--extension`: the VS Code Razor cohost extension DLL. */
  extensionDll: string;
  /** `--csharpDesignTimePath`: a design-time targets polyfill Razor needs outside C# Dev Kit. */
  csharpDesignTimePath: string;
}

/**
 * The Razor cohost files ship *inside* the `roslyn-language-server.{rid}` package, alongside the
 * server binary (i.e. in `serverDir`). Kept pure (path joins only) so it stays unit-testable; the
 * controller verifies both files actually exist before enabling Razor (their presence confirms a
 * Razor-capable package).
 *
 * `extensionDll` is the server's bundled Razor extension. It is used only as an existence signal — it
 * is NOT passed via `--extension` (the built-in-Razor server auto-loads it; passing it explicitly
 * breaks the Razor source-generator wiring — see `RazorLaunch` in `roslynServer.ts`). Only
 * `csharpDesignTimePath` (the design-time targets polyfill for non-SDK Razor) is passed to the server.
 */
export function razorLaunchPaths(serverDir: string): RazorLaunchPaths {
  return {
    extensionDll: path.join(serverDir, "Microsoft.VisualStudioCode.RazorExtension.dll"),
    csharpDesignTimePath: path.join(serverDir, "Targets", "Microsoft.CSharpExtension.DesignTime.targets"),
  };
}

/**
 * The outcome of deciding whether Razor cohosting can run for a resolved server: `off` (disabled),
 * `unavailable` (the server is too old to route Razor to the cohost handlers, or the package is
 * missing the bundled cohost files — Razor stays on highlighting only, `detail` says why), or
 * `loaded` (the cohost files are present and ready to launch).
 */
export type RazorDecision =
  | { kind: "off" }
  | { kind: "unavailable"; detail: string }
  | { kind: "loaded"; version: string; paths: RazorLaunchPaths };

/**
 * Pure Razor-cohosting decision, so the fallback matrix is unit-testable without `vscode`/IO. The
 * controller supplies `enabled` (from settings), the resolved server `version` and `serverDir`, and a
 * `fileExists` predicate (`existsSync` in production). Nothing is downloaded here — the Razor service
 * ships inside the server package; we only confirm the bundled files are present next to the binary.
 */
export function decideRazor(
  enabled: boolean,
  version: string,
  serverDir: string,
  fileExists: (p: string) => boolean,
): RazorDecision {
  if (!enabled) {
    return { kind: "off" };
  }
  if (!serverSupportsRazorCohost(version)) {
    return {
      kind: "unavailable",
      detail:
        `This C# server build (${version}) predates Razor cohosting ` +
        `(needs ≥ ${RAZOR_COHOST_MIN_SERVER_VERSION}); using Razor highlighting only.`,
    };
  }
  const paths = razorLaunchPaths(serverDir);
  const missing = Object.values(paths).filter((p) => !fileExists(p));
  if (missing.length > 0) {
    return {
      kind: "unavailable",
      detail: `The server package is missing Razor cohost files (${missing
        .map((p) => path.basename(p))
        .join(", ")}); using Razor highlighting only.`,
    };
  }
  return { kind: "loaded", version, paths };
}

/**
 * Extracts the PackageBaseAddress ("flat container") endpoint from a NuGet v3 service index — the
 * resource we download `.nupkg` files from. Discovering it from the index (rather than hardcoding a
 * host) mirrors how `nugetEndpoints.parseServiceIndexByType` finds the search endpoint and survives
 * host changes.
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

/**
 * The path prefix inside the `.nupkg` ZIP that holds a RID's server files. The `roslyn-language-server`
 * tool package lays them out under `tools/<tfm>/<rid>/`; the TFM is tied to the pinned
 * `ROSLYN_LS_VERSION` (currently `net10.0`) and must be bumped alongside it if the server retargets.
 */
export function packageContentPrefix(rid: Rid): string {
  return `tools/net10.0/${rid}/`;
}

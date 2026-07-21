// Downloads and caches the Roslyn language server. We fetch the RID-specific `.nupkg` directly over
// HTTP (a `.nupkg` is a ZIP) and unzip it ourselves — no `dotnet restore`, so no .NET SDK is
// required just to obtain the server (a runtime is still needed to run it). The cache is global and
// keyed by version;
// a `.complete` marker written only after the expected binary is verified means an aborted or
// partial download never leaves a "usable" cache behind.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { extractZipPrefix } from "../shared/archive.js";
import { DownloadUnreachableError, downloadFile, exists, makeReporter } from "../shared/httpDownload.js";
import { clearVersionCache, pruneVersionCache } from "../shared/versionedCache.js";
import { Rid } from "./rid.js";
import {
  ROSLYN_FEED_INDEX,
  ROSLYN_FEED_INDEX_FALLBACK,
  nupkgUrl,
  packageContentPrefix,
  parsePackageBaseAddress,
  resolveBaseAddressFrom,
  serverEntry,
} from "./roslynPackage.js";

export interface ResolvedServer {
  rid: Rid;
  version: string;
  /** Absolute path to the extracted RID directory. */
  dir: string;
  /** Absolute path to the server executable/DLL. */
  entryPath: string;
  /** How to launch it: native apphost ("exe") or DLL via `dotnet exec` ("dll"). */
  kind: "exe" | "dll";
}

/** Raised when the feed can't be reached (offline/proxy) so callers can show an actionable message. */
export class FeedUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      "Could not reach the C# language server feed. Check your internet connection or proxy, " +
        "or set 'csharpSolutionExplorer.languageServer.serverPath' to a locally installed server.",
    );
    this.name = "FeedUnreachableError";
    this.cause = cause;
  }
}

/**
 * Ensures the given server version for `rid` is present in the global cache, downloading and
 * extracting it (with a progress notification) on a cache miss. Returns the resolved entry point.
 */
export async function ensureServerDownloaded(
  storageRoot: vscode.Uri,
  rid: Rid,
  version: string,
): Promise<ResolvedServer> {
  const entry = serverEntry(rid);
  const versionDir = path.join(storageRoot.fsPath, "roslyn", version);
  const ridDir = path.join(versionDir, rid);
  const marker = path.join(ridDir, ".complete");
  const entryPath = path.join(ridDir, entry.relPath);

  if ((await exists(marker)) && (await exists(entryPath))) {
    return { rid, version, dir: ridDir, entryPath, kind: entry.kind };
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading C# language server ${version} (${rid})`,
      cancellable: false,
    },
    async (progress) => {
      const report = makeReporter(progress);
      await fsp.mkdir(versionDir, { recursive: true });
      // Drop any leftover partial dir from a previously aborted attempt.
      await fsp.rm(ridDir, { recursive: true, force: true });
      const tmpDir = `${ridDir}.tmp-${process.pid}-${Date.now()}`;
      const nupkgPath = `${ridDir}.nupkg.tmp`;
      try {
        const base = await resolveBaseAddress();
        try {
          await downloadFile(nupkgUrl(base, rid, version), nupkgPath, report, "the C# language server");
        } catch (err) {
          throw err instanceof DownloadUnreachableError ? new FeedUnreachableError(err.cause) : err;
        }
        report("Extracting…");
        await extractZipPrefix(nupkgPath, packageContentPrefix(rid), tmpDir);

        const tmpEntry = path.join(tmpDir, entry.relPath);
        if (!(await exists(tmpEntry))) {
          throw new Error(`The downloaded package did not contain ${entry.relPath}.`);
        }
        if (entry.kind === "exe") {
          // Extraction does not always preserve the executable bit on the native apphost.
          await fsp.chmod(tmpEntry, 0o755);
        }
        // Atomic publish: rename the fully-verified temp dir into place, then mark complete.
        await fsp.rename(tmpDir, ridDir);
        await fsp.writeFile(marker, `${version}\n`);
      } finally {
        await fsp.rm(nupkgPath, { force: true });
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  return { rid, version, dir: ridDir, entryPath, kind: entry.kind };
}

/**
 * Resolves the flat-container (PackageBaseAddress) endpoint from the primary feed, falling back to the
 * mirror if the primary is unreachable or doesn't advertise one. Only if both fail do we surface a
 * `FeedUnreachableError` (the primary's cause) so the user gets an actionable message.
 */
async function resolveBaseAddress(): Promise<string> {
  try {
    return await resolveBaseAddressFrom([ROSLYN_FEED_INDEX, ROSLYN_FEED_INDEX_FALLBACK], fetchBaseAddress);
  } catch (err) {
    throw new FeedUnreachableError(err);
  }
}

async function fetchBaseAddress(indexUrl: string): Promise<string> {
  const res = await fetch(indexUrl, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const base = parsePackageBaseAddress(await res.json());
  if (!base) {
    throw new Error("The C# language server feed did not advertise a package base address.");
  }
  return base;
}

/** Absolute path to the global server cache root (`<storage>/roslyn`). */
function cacheRoot(storageRoot: vscode.Uri): string {
  return path.join(storageRoot.fsPath, "roslyn");
}

/** Removes every cached server version except `keepVersion`. Returns the removed folder names. */
export function pruneServerCache(storageRoot: vscode.Uri, keepVersion: string): Promise<string[]> {
  return pruneVersionCache(cacheRoot(storageRoot), keepVersion);
}

/** Deletes the entire server cache (`<storage>/roslyn`). Used by the "Clear Server Cache" command. */
export function clearServerCache(storageRoot: vscode.Uri): Promise<void> {
  return clearVersionCache(cacheRoot(storageRoot));
}

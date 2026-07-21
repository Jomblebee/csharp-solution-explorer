// Downloads and caches the netcoredbg debug adapter from its GitHub release. The cache is global
// and keyed by version; a `.complete` marker written only after the executable is verified means an
// aborted download never leaves a "usable" cache behind.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { extractTarGz, extractZipPrefix } from "../shared/archive.js";
import { DownloadUnreachableError, downloadFile, exists, makeReporter } from "../shared/httpDownload.js";
import { clearVersionCache, pruneVersionCache } from "../shared/versionedCache.js";
import { ARCHIVE_PREFIX, archiveKind, binaryRelPath, DebugRid, releaseAssetUrl } from "./netcoredbgPackage.js";

export interface ResolvedDebugger {
  rid: DebugRid;
  version: string;
  /** Absolute path to the extracted directory. */
  dir: string;
  /** Absolute path to the `netcoredbg` executable. */
  binaryPath: string;
}

/** Raised when GitHub can't be reached, so callers can point at the `debuggerPath` escape hatch. */
export class DebuggerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      "Could not download the .NET debugger from GitHub. Check your internet connection or proxy, " +
        "or set 'csharpSolutionExplorer.debug.debuggerPath' to a locally built netcoredbg.",
    );
    this.name = "DebuggerUnreachableError";
    this.cause = cause;
  }
}

/**
 * Ensures the given netcoredbg version for `rid` is in the global cache, downloading and extracting
 * it (with a progress notification) on a cache miss. Returns the resolved executable.
 *
 * No ad-hoc code signing is needed on macOS: Samsung already ships the binary linker-signed, and
 * files fetched programmatically carry no `com.apple.quarantine` attribute — verified on
 * macOS arm64. Do not "fix" this by adding a `codesign` step.
 */
export async function ensureDebuggerDownloaded(
  storageRoot: vscode.Uri,
  rid: DebugRid,
  version: string,
): Promise<ResolvedDebugger> {
  const versionDir = path.join(cacheRoot(storageRoot), version);
  const ridDir = path.join(versionDir, rid);
  const marker = path.join(ridDir, ".complete");
  const binaryPath = path.join(ridDir, binaryRelPath(rid));

  if ((await exists(marker)) && (await exists(binaryPath))) {
    return { rid, version, dir: ridDir, binaryPath };
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading .NET debugger ${version} (${rid})`,
      cancellable: false,
    },
    async (progress) => {
      const report = makeReporter(progress);
      await fsp.mkdir(versionDir, { recursive: true });
      // Drop any leftover partial dir from a previously aborted attempt.
      await fsp.rm(ridDir, { recursive: true, force: true });
      const tmpDir = `${ridDir}.tmp-${process.pid}-${Date.now()}`;
      const archivePath = `${ridDir}.archive.tmp`;
      try {
        try {
          await downloadFile(releaseAssetUrl(rid, version), archivePath, report, "the .NET debugger");
        } catch (err) {
          throw err instanceof DownloadUnreachableError ? new DebuggerUnreachableError(err.cause) : err;
        }
        report("Extracting…");
        if (archiveKind(rid) === "zip") {
          await extractZipPrefix(archivePath, ARCHIVE_PREFIX, tmpDir);
        } else {
          // tar keeps the `netcoredbg/` wrapper directory, so extract and then unwrap it.
          await extractTarGz(archivePath, `${tmpDir}.raw`);
          await fsp.rename(path.join(`${tmpDir}.raw`, "netcoredbg"), tmpDir);
        }

        const tmpBinary = path.join(tmpDir, binaryRelPath(rid));
        if (!(await exists(tmpBinary))) {
          throw new Error(`The downloaded archive did not contain ${binaryRelPath(rid)}.`);
        }
        // Extraction does not always preserve the executable bit.
        await fsp.chmod(tmpBinary, 0o755);
        // Atomic publish: rename the fully-verified temp dir into place, then mark complete.
        await fsp.rename(tmpDir, ridDir);
        await fsp.writeFile(marker, `${version}\n`);
      } finally {
        await fsp.rm(archivePath, { force: true });
        await fsp.rm(tmpDir, { recursive: true, force: true });
        await fsp.rm(`${tmpDir}.raw`, { recursive: true, force: true });
      }
    },
  );

  return { rid, version, dir: ridDir, binaryPath };
}

/** Absolute path to the global debugger cache root (`<storage>/netcoredbg`). */
function cacheRoot(storageRoot: vscode.Uri): string {
  return path.join(storageRoot.fsPath, "netcoredbg");
}

/** Removes every cached debugger version except `keepVersion`. Returns the removed folder names. */
export function pruneDebuggerCache(storageRoot: vscode.Uri, keepVersion: string): Promise<string[]> {
  return pruneVersionCache(cacheRoot(storageRoot), keepVersion);
}

export function clearDebuggerCache(storageRoot: vscode.Uri): Promise<void> {
  return clearVersionCache(cacheRoot(storageRoot));
}

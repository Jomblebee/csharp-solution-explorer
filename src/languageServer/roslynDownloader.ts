// Downloads and caches the Roslyn language server. We fetch the RID-specific `.nupkg` directly over
// HTTP (a `.nupkg` is a ZIP) and unzip it ourselves — no `dotnet restore`, so no .NET SDK is
// required just to obtain the server (a runtime is still needed to run it). The cache is global and
// keyed by version;
// a `.complete` marker written only after the expected binary is verified means an aborted or
// partial download never leaves a "usable" cache behind.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import * as vscode from "vscode";
import yauzl from "yauzl";
import { Rid } from "./rid.js";
import {
  ROSLYN_FEED_INDEX,
  ROSLYN_FEED_INDEX_FALLBACK,
  nupkgUrl,
  packageContentPrefix,
  parsePackageBaseAddress,
  resolveBaseAddressFrom,
  serverEntry,
  versionsToPrune,
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
        await downloadFile(nupkgUrl(base, rid, version), nupkgPath, report);
        report("Extracting…");
        await extractPrefix(nupkgPath, packageContentPrefix(rid), tmpDir);

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

type Reporter = (message?: string, fraction?: number) => void;

/** Turns absolute-fraction reports into the delta `increment`s VS Code's progress API expects. */
function makeReporter(progress: vscode.Progress<{ message?: string; increment?: number }>): Reporter {
  let lastPct = 0;
  return (message, fraction) => {
    const update: { message?: string; increment?: number } = {};
    if (message !== undefined) {
      update.message = message;
    }
    if (typeof fraction === "number") {
      const pct = Math.max(0, Math.min(100, fraction * 100));
      update.increment = Math.max(0, pct - lastPct);
      lastPct = pct;
    }
    progress.report(update);
  };
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

async function downloadFile(url: string, dest: string, report: Reporter): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/octet-stream" } });
  } catch (err) {
    throw new FeedUnreachableError(err);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the C# language server (${res.status} ${res.statusText}).`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      report(`Downloading… ${mb(received)} / ${mb(total)} MB`, received / total);
    } else {
      report(`Downloading… ${mb(received)} MB`);
    }
  });
  await pipeline(source, fs.createWriteStream(dest));
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(0);

/**
 * Extracts only the entries under `prefix` from `nupkgPath`, stripping that prefix, into `destDir`.
 * Preserves the stored unix file mode (defaulting to 0o644) and guards against zip-slip paths.
 */
function extractPrefix(nupkgPath: string, prefix: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(nupkgPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error("Could not open the downloaded package."));
        return;
      }
      const fail = (err: unknown): void => {
        zip.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (!name.startsWith(prefix)) {
          zip.readEntry();
          return;
        }
        const rel = name.slice(prefix.length);
        if (rel === "" || rel.endsWith("/")) {
          // Directory entry (or the prefix root itself).
          if (rel === "") {
            zip.readEntry();
            return;
          }
          fsp.mkdir(path.join(destDir, rel), { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        const target = safeJoin(destDir, rel);
        if (!target) {
          fail(new Error(`Refusing to extract unsafe path from package: ${name}`));
          return;
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o777;
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error("Could not read package entry."));
            return;
          }
          fsp.mkdir(path.dirname(target), { recursive: true }).then(() => {
            const writeStream = fs.createWriteStream(target, { mode: mode || 0o644 });
            readStream.on("error", fail);
            writeStream.on("error", fail);
            writeStream.on("close", () => zip.readEntry());
            readStream.pipe(writeStream);
          }, fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** Joins `rel` onto `base`, returning `undefined` if it would escape `base` (zip-slip guard). */
function safeJoin(base: string, rel: string): string | undefined {
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return undefined;
  }
  return target;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the global server cache root (`<storage>/roslyn`). */
function cacheRoot(storageRoot: vscode.Uri): string {
  return path.join(storageRoot.fsPath, "roslyn");
}

/**
 * Removes every cached server version except `keepVersion`, so old builds don't accumulate after a
 * version bump. Best-effort: a missing cache root or a failed individual removal is ignored (the
 * caller runs this fire-and-forget after a successful download). Returns the version folder names
 * that were removed, for logging.
 */
export async function pruneServerCache(storageRoot: vscode.Uri, keepVersion: string): Promise<string[]> {
  const root = cacheRoot(storageRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const removed: string[] = [];
  for (const name of versionsToPrune(names, keepVersion)) {
    try {
      await fsp.rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Leave a version we couldn't remove; it will be retried on a later start.
    }
  }
  return removed;
}

/** Deletes the entire server cache (`<storage>/roslyn`). Used by the "Clear Server Cache" command. */
export async function clearServerCache(storageRoot: vscode.Uri): Promise<void> {
  await fsp.rm(cacheRoot(storageRoot), { recursive: true, force: true });
}

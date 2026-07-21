// Archive extraction shared by the language server (NuGet `.nupkg`, a ZIP) and the debugger
// (netcoredbg ships `.zip` for macOS/Windows and `.tar.gz` for Linux).

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yauzl from "yauzl";

const execFileAsync = promisify(execFile);

/** Joins `rel` onto `base`, returning `undefined` if it would escape `base` (zip-slip guard). */
export function safeJoin(base: string, rel: string): string | undefined {
  const root = path.resolve(base);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return undefined;
  }
  return target;
}

/**
 * Extracts only the entries under `prefix` from `zipPath`, stripping that prefix, into `destDir`.
 * Preserves the stored unix file mode (defaulting to 0o644) and guards against zip-slip paths.
 * Pass an empty `prefix` to extract the whole archive.
 */
export function extractZipPrefix(zipPath: string, prefix: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error("Could not open the downloaded archive."));
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
          fail(new Error(`Refusing to extract unsafe path from archive: ${name}`));
          return;
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o777;
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error("Could not read archive entry."));
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

/**
 * Extracts a `.tar.gz` into `destDir` via the system `tar`. Only Linux needs this (netcoredbg
 * ships ZIPs for macOS and Windows), and every Linux that can run VS Code has `tar` — so shelling
 * out beats both a new dependency and hand-rolling a tar reader with its own traversal surface.
 * `destDir` is always a freshly created empty temp dir, and GNU/bsd tar reject `..` members.
 */
export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir], { windowsHide: true });
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      throw new Error("The 'tar' command was not found on PATH, so the archive could not be extracted.");
    }
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

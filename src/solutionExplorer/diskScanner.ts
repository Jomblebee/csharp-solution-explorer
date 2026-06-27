import * as fs from "node:fs";
import * as path from "node:path";

export interface ScannedEntry {
  kind: "folder" | "file";
  name: string;
  path: string;
}

export const DEFAULT_EXCLUDED_DIR_NAMES: readonly string[] = ["bin", "obj", "node_modules"];

export function shouldExcludeDir(
  dirName: string,
  excluded: readonly string[] = DEFAULT_EXCLUDED_DIR_NAMES,
): boolean {
  return dirName.startsWith(".") || excluded.includes(dirName);
}

/**
 * Lists the direct children of a single directory level (non-recursive — matches
 * how TreeDataProvider.getChildren is called, once per expanded node), excluding
 * bin/obj/node_modules/hidden directories. Folders sorted before files, each group
 * alphabetically (case-insensitive).
 */
export function listDirectChildren(dirPath: string): ScannedEntry[] {
  const dirents = fs.readdirSync(dirPath, { withFileTypes: true });

  const entries: ScannedEntry[] = [];
  for (const dirent of dirents) {
    const isDirectory = dirent.isDirectory();
    if (isDirectory && shouldExcludeDir(dirent.name)) {
      continue;
    }
    entries.push({
      kind: isDirectory ? "folder" : "file",
      name: dirent.name,
      path: path.join(dirPath, dirent.name),
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}

/**
 * Recursively walks `rootDir` (skipping bin/obj/node_modules/hidden directories, same as
 * `listDirectChildren`), returning every file as a POSIX-style path relative to `rootDir`.
 * Used for MSBuild glob resolution, which needs the full file set regardless of which
 * folders are currently expanded in the tree.
 */
export function listAllFilesRecursive(rootDir: string): string[] {
  const results: string[] = [];

  const walk = (dirPath: string, relativePrefix: string) => {
    const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (shouldExcludeDir(dirent.name)) {
          continue;
        }
        walk(path.join(dirPath, dirent.name), `${relativePrefix}${dirent.name}/`);
      } else {
        results.push(`${relativePrefix}${dirent.name}`);
      }
    }
  };

  walk(rootDir, "");
  return results;
}

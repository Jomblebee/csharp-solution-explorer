import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isInsideOrEqual, resolveCopyDestName } from "./fsPathUtils.js";
import { FsEntry } from "./types.js";

export interface FsOpResult {
  /** True when at least one entry was moved/copied, so the tree should refresh. */
  changed: boolean;
  errors: string[];
}

/**
 * Moves the given files/folders into `targetDir` on disk (via rename). Callers are expected to have
 * already filtered out entries that are already in the target directory. A folder cannot be moved
 * into itself or a descendant. Name collisions leave the source in place and report an error.
 */
export async function moveEntriesInto(entries: FsEntry[], targetDir: vscode.Uri): Promise<FsOpResult> {
  const errors: string[] = [];
  let changed = false;

  for (const entry of entries) {
    if (entry.kind === "folder" && isInsideOrEqual(targetDir.fsPath, entry.uri.fsPath)) {
      errors.push(`'${entry.name}' cannot be moved into itself.`);
      continue;
    }
    const destUri = vscode.Uri.joinPath(targetDir, entry.name);
    try {
      await vscode.workspace.fs.rename(entry.uri, destUri, { overwrite: false });
      changed = true;
    } catch {
      errors.push(`'${entry.name}' could not be moved (a file or folder with that name may already exist).`);
    }
  }

  return { changed, errors };
}

/**
 * Copies the given files/folders into `targetDir` on disk (recursively for folders). When the name is
 * already taken, a free " copy" name is used instead of overwriting. A folder cannot be copied into
 * itself or a descendant.
 */
export async function copyEntriesInto(entries: FsEntry[], targetDir: vscode.Uri): Promise<FsOpResult> {
  const errors: string[] = [];
  let changed = false;

  for (const entry of entries) {
    if (entry.kind === "folder" && isInsideOrEqual(targetDir.fsPath, entry.uri.fsPath)) {
      errors.push(`'${entry.name}' cannot be copied into itself.`);
      continue;
    }
    const destName = resolveCopyDestName(entry.name, entry.kind === "folder", (candidate) =>
      fs.existsSync(path.join(targetDir.fsPath, candidate)),
    );
    const destUri = vscode.Uri.joinPath(targetDir, destName);
    try {
      await vscode.workspace.fs.copy(entry.uri, destUri, { overwrite: false });
      changed = true;
    } catch {
      errors.push(`'${entry.name}' could not be copied.`);
    }
  }

  return { changed, errors };
}

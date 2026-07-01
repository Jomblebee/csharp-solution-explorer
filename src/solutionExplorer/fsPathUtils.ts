import * as path from "node:path";

/** True when `candidate` is `base` itself or a path nested below it. */
export function isInsideOrEqual(candidate: string, base: string): boolean {
  if (candidate === base) {
    return true;
  }
  return candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Picks the project root that owns `target` — the longest root path that contains the target.
 * Returns `undefined` when the target lives outside every given project root.
 */
export function pickOwningProjectPath(rootPaths: string[], target: string): string | undefined {
  let best: string | undefined;
  for (const root of rootPaths) {
    if (isInsideOrEqual(target, root) && (best === undefined || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

/** Splits a name into stem + extension. Directories (and dotfiles) have no extension. */
function splitName(name: string, isDirectory: boolean): { stem: string; ext: string } {
  if (isDirectory) {
    return { stem: name, ext: "" };
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Resolves the name a copy should get in the target directory. Keeps the original name when it's
 * free; otherwise appends " copy", " copy 2", … before the extension (Visual Studio / Explorer style).
 * `exists` reports whether a given candidate name is already taken in the target directory.
 */
export function resolveCopyDestName(
  name: string,
  isDirectory: boolean,
  exists: (candidate: string) => boolean,
): string {
  if (!exists(name)) {
    return name;
  }
  const { stem, ext } = splitName(name, isDirectory);
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

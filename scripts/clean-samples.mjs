// Removes the build output of the sample solutions — every `bin` and `obj` directory under
// `samples/`. Those are git-ignored, so they never show up in `git status` and quietly grow to a
// few hundred megabytes as the samples get built by the Extension Development Host.
//
//   npm run sample:clean
//
// Deliberately limited to bin/obj. `.vs/` and the `taskflow.db*` files also sit there ignored, but
// they carry manual test state (window layout, seeded sample data) that is annoying to recreate.
// Idempotent: a second run finds nothing and says so.

import { readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(repoRoot, "samples");

const TARGETS = new Set(["bin", "obj"]);

/** Collects every bin/obj directory below `dir`, without descending into the ones it finds. */
function findTargets(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = join(dir, entry.name);
    if (TARGETS.has(entry.name)) {
      found.push(child);
    } else {
      found.push(...findTargets(child));
    }
  }
  return found;
}

/** Total size of a directory tree in bytes. Symlinks are counted as their link, not their target. */
function treeSize(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      bytes += treeSize(child);
    } else if (entry.isFile()) {
      bytes += statSync(child).size;
    }
  }
  return bytes;
}

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const targets = findTargets(samplesDir);

let freed = 0;
for (const target of targets) {
  const bytes = treeSize(target);
  rmSync(target, { recursive: true, force: true });
  freed += bytes;
  console.log(`  ✓ ${relative(repoRoot, target)} (${formatSize(bytes)})`);
}

console.log(
  targets.length === 0
    ? "\nNothing to clean — no bin/obj directories under samples/.\n"
    : `\nRemoved ${targets.length} director${targets.length === 1 ? "y" : "ies"}, freed ${formatSize(freed)}.\n`,
);

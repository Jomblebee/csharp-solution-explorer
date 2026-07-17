// Creates and pushes the release tag `v<version>` (version read from package.json), which triggers
// the Release workflow (.github/workflows/release.yml): build VSIX → GitHub Release → Open VSX
// publish. Because that publish is irreversible (Open VSX won't accept the same version twice), this
// script refuses to run unless the state is clearly release-ready:
//   - on the `main` branch,
//   - working tree clean (no uncommitted changes),
//   - local `main` in sync with `origin/main`,
//   - the tag does not already exist locally or on the remote.
// Run via `npm run release:tag` or the "Tag & publish release" VS Code task.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const tag = `v${version}`;

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  fail(`Not on 'main' (on '${branch}'). Releases are tagged from main only.`);
}

if (git("status", "--porcelain") !== "") {
  fail("Working tree is not clean. Commit or stash your changes before tagging.");
}

// Make sure we compare against the true remote state, not a stale local ref.
git("fetch", "origin", "main", "--tags");
const local = git("rev-parse", "main");
const remote = git("rev-parse", "origin/main");
if (local !== remote) {
  fail("Local 'main' is not in sync with 'origin/main'. Pull/push so they match, then retry.");
}

const existing = git("tag", "--list", tag);
if (existing !== "") {
  fail(`Tag ${tag} already exists locally. Version ${version} was likely already released.`);
}
const remoteTag = git("ls-remote", "--tags", "origin", tag);
if (remoteTag !== "") {
  fail(`Tag ${tag} already exists on origin. Bump the version in package.json before releasing.`);
}

console.log(`Tagging ${tag} on ${local.slice(0, 8)} and pushing to origin…`);
git("tag", "-a", tag, "-m", tag);
git("push", "origin", tag);

console.log(`\n✓ Pushed ${tag}. The Release workflow will build the VSIX, create the GitHub Release,`);
console.log(`  and publish to Open VSX. Watch it at:`);
console.log(`  https://github.com/Jomblebee/csharp-solution-explorer/actions\n`);

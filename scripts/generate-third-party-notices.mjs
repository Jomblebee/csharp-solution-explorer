#!/usr/bin/env node
// Regenerates the "Bundled npm dependencies" section of THIRD_PARTY_NOTICES.md.
//
// Only production dependencies are listed: devDependencies never reach the VSIX, while
// every production dependency is inlined into dist/extension.js by esbuild and therefore
// ships as part of this extension. MIT, ISC and Blue Oak all require the copyright line
// and the full licence text to travel with the distributed copy, so both are embedded
// here verbatim rather than merely referenced.
//
// Usage: node scripts/generate-third-party-notices.mjs [--check]
//   --check  exit non-zero if the file is out of date (for CI), writing nothing.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const noticesPath = join(repoRoot, "THIRD_PARTY_NOTICES.md");

const BEGIN = "<!-- BEGIN GENERATED npm NOTICES -->";
const END = "<!-- END GENERATED npm NOTICES -->";

const LICENSE_FILE = /^(licen[cs]e|copying)(\.\w+)?$/i;

/**
 * Licences a shipped dependency may carry. Everything here is permissive and compatible
 * with redistributing the bundle under MIT. Copyleft (GPL/LGPL/AGPL/MPL/SSPL) and
 * source-available licences are rejected outright: this extension ships a single bundled
 * dist/extension.js, so a copyleft dependency would put its terms on the whole file.
 */
const ALLOWED_LICENSES = new Set(["MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "BlueOak-1.0.0", "CC0-1.0", "Unlicense"]);

/** Short note on why each direct dependency is here, so the notice stays readable. */
const PURPOSE = {
  "vscode-languageclient": "LSP client used to talk to the Roslyn language server.",
  "vscode-jsonrpc": "JSON-RPC transport underneath the LSP client.",
  minimatch: "glob matching for solution/project file filters.",
  yauzl: "unzips the downloaded language server and debugger packages.",
};

function productionPackages() {
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const seen = new Map();
  const walk = (node, depth) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const key = `${name}@${child.version}`;
      if (!seen.has(key) && child.path) {
        seen.set(key, { name, version: child.version, license: child.license, path: child.path, direct: depth === 0 });
      }
      walk(child, depth + 1);
    }
  };
  walk(JSON.parse(raw), 0);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function licenseText(pkg) {
  const file = readdirSync(pkg.path).find((entry) => LICENSE_FILE.test(entry));
  if (!file) throw new Error(`no licence file found in ${pkg.path} — cannot attribute ${pkg.name}`);
  return readFileSync(join(pkg.path, file), "utf8").trim();
}

const manifests = new Map();

/** The installed package.json, not the lockfile: it is what actually ships. */
function manifest(pkg) {
  let cached = manifests.get(pkg.path);
  if (!cached) {
    cached = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
    manifests.set(pkg.path, cached);
  }
  return cached;
}

function licenseId(pkg) {
  const raw = manifest(pkg).license ?? pkg.license;
  const id = typeof raw === "object" && raw ? raw.type : raw;
  if (!id) throw new Error(`no licence declared for ${pkg.name}@${pkg.version}`);
  return id;
}

/** An SPDX `OR` expression is satisfiable if any one of its choices is allowed. */
function isAllowed(id) {
  return id
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .some((choice) => ALLOWED_LICENSES.has(choice.trim()));
}

function assertLicensesAllowed(packages) {
  const rejected = packages.filter((pkg) => !isAllowed(licenseId(pkg)));
  if (rejected.length === 0) return;
  const list = rejected.map((pkg) => `  ${pkg.name}@${pkg.version} — ${licenseId(pkg)}`).join("\n");
  throw new Error(
    `shipped dependencies carry licences that are not on the allow-list:\n${list}\n\n` +
      `Either drop the dependency or, if the licence is genuinely permissive and compatible ` +
      `with redistribution under MIT, add it to ALLOWED_LICENSES in this script.`,
  );
}

function repoUrl(pkg) {
  const { repository } = manifest(pkg);
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) return `https://www.npmjs.com/package/${pkg.name}`;
  return url
    .replace(/^git\+/, "")
    .replace(/^github:(.+)$/, "https://github.com/$1")
    .replace(/^git@([^:]+):/, "https://$1/") // scp-style: git@github.com:owner/repo
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

function render(packages) {
  const lines = [
    BEGIN,
    "",
    "## Bundled npm dependencies",
    "",
    "These packages are inlined into `dist/extension.js` by esbuild and are therefore",
    "distributed as part of this extension. Their licences and copyright notices follow in",
    "full. Development-only dependencies are not listed because they are never shipped.",
    "",
    "| Package | Version | Licence |",
    "| --- | --- | --- |",
  ];
  for (const pkg of packages) {
    lines.push(`| [\`${pkg.name}\`](${repoUrl(pkg)}) | ${pkg.version} | ${licenseId(pkg)} |`);
  }
  lines.push("");
  for (const pkg of packages) {
    lines.push(`### \`${pkg.name}\` ${pkg.version} — ${licenseId(pkg)}`);
    lines.push("");
    if (pkg.direct && PURPOSE[pkg.name]) lines.push(`Used for ${PURPOSE[pkg.name]}`, "");
    else if (!pkg.direct) lines.push(`Transitive dependency.`, "");
    lines.push("```", licenseText(pkg), "```", "");
  }
  lines.push(END);
  return lines.join("\n");
}

const existing = readFileSync(noticesPath, "utf8");
const begin = existing.indexOf(BEGIN);
const end = existing.indexOf(END);
if (begin === -1 || end === -1) {
  throw new Error(`markers ${BEGIN} / ${END} not found in THIRD_PARTY_NOTICES.md`);
}

const packages = productionPackages();
assertLicensesAllowed(packages);

const updated = existing.slice(0, begin) + render(packages) + existing.slice(end + END.length);

if (process.argv.includes("--check")) {
  if (updated !== existing) {
    console.error("THIRD_PARTY_NOTICES.md is out of date — run `npm run notices`.");
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${packages.length} shipped packages, all licences allowed).`);
} else {
  writeFileSync(noticesPath, updated);
  console.log("THIRD_PARTY_NOTICES.md updated.");
}

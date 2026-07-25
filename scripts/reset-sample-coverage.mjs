// Resets the coverage state of the TaskFlow sample test projects, so the Test Explorer's
// "Code coverage needs an extra package … Add it and continue?" prompt stays reproducible by hand.
//
// Choosing "Add & Continue" on that prompt permanently writes a PackageReference into the sample
// csproj — after that the prompt never appears again and the flow can only be re-tested by undoing
// the edit. This script is that undo (and, with `--with-coverage`, the opposite setup).
//
//   npm run sample:reset-coverage                  strip every coverage package → prompt appears
//   npm run sample:reset-coverage -- --with-coverage   pre-install them → no prompt, coverage collected
//
// Both modes are idempotent. Only TaskFlow.Tests.XUnitV3 (MTP) and TaskFlow.Tests (VSTest) are prompt
// fixtures: TaskFlow.Tests.MSTest and TaskFlow.Tests.TUnit get Microsoft.Testing.Extensions.CodeCoverage
// transitively from their test framework and must stay unprompted, which is what the assets-based half
// of the check exists for. They are stripped here only so a stray direct reference cannot creep in.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(repoRoot, "samples", "TaskFlow", "tests");
const withCoverage = process.argv.includes("--with-coverage");

const MTP_COVERAGE_PACKAGE = "Microsoft.Testing.Extensions.CodeCoverage";
const VSTEST_COVERAGE_PACKAGE = "coverlet.collector";

// The projects the Test Explorer prompts for, with the package + version that actually works there.
// The MTP extension major must match the test framework's Microsoft.Testing.Platform major (18.x =
// MTP v2, as used by xunit.v3.mtp-v2); a mismatched major loads but then throws at startup.
const PROJECTS = {
  "TaskFlow.Tests": { package: VSTEST_COVERAGE_PACKAGE, version: "6.*" },
  "TaskFlow.Tests.XUnitV3": { package: MTP_COVERAGE_PACKAGE, version: "18.*" },
  // Framework-supplied (transitive) coverage — only ever stripped, never pre-installed.
  "TaskFlow.Tests.MSTest": null,
  "TaskFlow.Tests.TUnit": null,
};

/** Drops every coverage PackageReference (self-closing or with a child element block) from the csproj. */
function stripCoveragePackages(text) {
  const names = [MTP_COVERAGE_PACKAGE, VSTEST_COVERAGE_PACKAGE].join("|");
  const pattern = new RegExp(
    `[ \\t]*<PackageReference\\s+Include="(?:${names})"[^>]*?(?:/>|>[\\s\\S]*?</PackageReference>)\\r?\\n`,
    "gi",
  );
  return text.replace(pattern, "");
}

/** Adds the package to the top of the csproj's first ItemGroup, matching its indentation. */
function addCoveragePackage(text, { package: packageId, version }) {
  const itemGroup = text.indexOf("  <ItemGroup>");
  if (itemGroup === -1) {
    throw new Error("no <ItemGroup> to add the coverage package to");
  }
  const insertAt = text.indexOf("\n", itemGroup) + 1;
  const line = `    <PackageReference Include="${packageId}" Version="${version}" />\n`;
  return text.slice(0, insertAt) + line + text.slice(insertAt);
}

let changed = 0;
for (const [projectDir, wanted] of Object.entries(PROJECTS)) {
  const csproj = join(testsDir, projectDir, `${projectDir}.csproj`);
  const before = readFileSync(csproj, "utf8");
  const stripped = stripCoveragePackages(before);
  const target = withCoverage && wanted ? wanted : null;
  const after = target ? addCoveragePackage(stripped, target) : stripped;
  const state = target ? `has ${target.package}` : "no coverage package";

  if (after === before) {
    console.log(`  = ${projectDir}: ${state}`);
    continue;
  }
  writeFileSync(csproj, after);
  changed++;
  console.log(`  ✓ ${projectDir}: ${state}`);
}

const goal = withCoverage
  ? "Run with Coverage should run without a prompt and report coverage."
  : "Run with Coverage should prompt for TaskFlow.Tests and TaskFlow.Tests.XUnitV3.";
console.log(`\n${changed === 0 ? "Already in that state" : `Updated ${changed} project(s)`}. ${goal}\n`);

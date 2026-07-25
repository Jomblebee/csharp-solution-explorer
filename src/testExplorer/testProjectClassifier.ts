// Decides whether a .csproj is a test project, from its text alone (no MSBuild). Pure and vscode-free
// so it is unit-testable. Detection mirrors how the tree already reasons about projects: an explicit
// <IsTestProject>true</IsTestProject> wins, otherwise a referenced test framework package is the tell.

import { parsePackageReferences } from "../solutionExplorer/parsers/csprojReader.js";

/** Substrings matched (case-insensitively) against PackageReference names. */
const TEST_PACKAGE_MARKERS = ["microsoft.net.test.sdk", "xunit", "nunit", "mstest", "tunit"];

export function isTestProject(csprojText: string): boolean {
  if (/<IsTestProject\s*>\s*true\s*<\/IsTestProject>/i.test(csprojText)) {
    return true;
  }
  return parsePackageReferences(csprojText).some((ref) => {
    const name = ref.name.toLowerCase();
    return TEST_PACKAGE_MARKERS.some((marker) => name.includes(marker));
  });
}

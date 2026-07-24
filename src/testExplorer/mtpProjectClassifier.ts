// Decides whether a test project runs on Microsoft.Testing.Platform (MTP) rather than classic VSTest.
// This matters on .NET 10 SDK, where the VSTest `dotnet test` target is gone: MTP projects must be
// driven through the MTP server-mode protocol instead. Pure and vscode-free so it is unit-testable.
//
// Signals (any one is enough): an explicit runner opt-in property, or a package reference to an
// MTP-native framework/runner. xUnit v3, TUnit and the *.Testing.Platform packages are MTP-only.

import { parsePackageReferences } from "../solutionExplorer/csprojReader.js";

const MTP_PROPERTY_PATTERN =
  /<(?:UseMicrosoftTestingPlatformRunner|EnableMSTestRunner|EnableNUnitRunner|TestingPlatformDotnetTestSupport)\s*>\s*true\s*<\//i;

/** Package-name substrings that imply MTP. `xunit.v3` and `tunit` are MTP-native by design. */
const MTP_PACKAGE_MARKERS = ["microsoft.testing.platform", "xunit.v3", "tunit"];

export function isMtpProject(csprojText: string): boolean {
  if (MTP_PROPERTY_PATTERN.test(csprojText)) {
    return true;
  }
  return parsePackageReferences(csprojText).some((ref) => {
    const name = ref.name.toLowerCase();
    return MTP_PACKAGE_MARKERS.some((marker) => name.includes(marker));
  });
}

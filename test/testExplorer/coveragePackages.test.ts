import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MTP_COVERAGE_PACKAGE,
  VSTEST_COVERAGE_PACKAGE,
  coverageExtensionMajor,
  coveragePackageId,
  hasCoveragePackage,
  hasMtpCoveragePackageInAssets,
  pickVersionForMajor,
  platformMajor,
} from "../../src/testExplorer/coveragePackages.js";
import type { ParsedAssetPackage, ParsedAssets } from "../../src/solutionExplorer/projectAssetsReader.js";

function pkg(name: string, version?: string, dependencies: ParsedAssetPackage[] = []): ParsedAssetPackage {
  return { name, version, dependencies };
}

function assetsOf(packages: ParsedAssetPackage[]): ParsedAssets {
  return { frameworks: [], packages, analyzers: [] };
}

describe("coveragePackageId", () => {
  it("picks the CodeCoverage extension for MTP projects", () => {
    assert.equal(coveragePackageId(true), MTP_COVERAGE_PACKAGE);
  });

  it("picks coverlet.collector for VSTest projects", () => {
    assert.equal(coveragePackageId(false), VSTEST_COVERAGE_PACKAGE);
  });
});

describe("hasCoveragePackage", () => {
  const mtpWith = `<Project><ItemGroup><PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="17.14.4" /></ItemGroup></Project>`;
  const mtpWithout = `<Project><ItemGroup><PackageReference Include="xunit.v3" Version="3.2.2" /></ItemGroup></Project>`;
  const vsWith = `<Project><ItemGroup><PackageReference Include="coverlet.collector" Version="6.0.2" /></ItemGroup></Project>`;
  const vsWithout = `<Project><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>`;

  it("detects the CodeCoverage extension for an MTP project", () => {
    assert.equal(hasCoveragePackage(mtpWith, true), true);
    assert.equal(hasCoveragePackage(mtpWithout, true), false);
  });

  it("detects coverlet.collector for a VSTest project", () => {
    assert.equal(hasCoveragePackage(vsWith, false), true);
    assert.equal(hasCoveragePackage(vsWithout, false), false);
  });

  it("does not accept the wrong runner's package", () => {
    // A VSTest project that happens to reference the MTP extension is still not "covered" as VSTest.
    assert.equal(hasCoveragePackage(mtpWith, false), false);
    assert.equal(hasCoveragePackage(vsWith, true), false);
  });
});

describe("hasMtpCoveragePackageInAssets", () => {
  // TUnit pulls the CodeCoverage extension in transitively — the shape this function exists for.
  const tunit = assetsOf([
    pkg("TUnit", "0.90.45", [pkg("Microsoft.Testing.Extensions.CodeCoverage", "18.1.0", [pkg("Microsoft.Testing.Platform", "2.3.0")])]),
  ]);

  it("finds the extension at any depth", () => {
    assert.equal(hasMtpCoveragePackageInAssets(tunit), true);
    assert.equal(hasMtpCoveragePackageInAssets(assetsOf([pkg("Microsoft.Testing.Extensions.CodeCoverage", "18.9.0")])), true);
  });

  it("reports a missing extension", () => {
    assert.equal(hasMtpCoveragePackageInAssets(assetsOf([pkg("xunit.v3.mtp-v2", "3.2.2", [pkg("Microsoft.Testing.Platform", "2.3.0")])])), false);
    assert.equal(hasMtpCoveragePackageInAssets(assetsOf([])), false);
  });

  it("terminates on a shared sub-graph", () => {
    const shared = pkg("Shared", "1.0.0", [pkg("Microsoft.Testing.Extensions.CodeCoverage", "18.1.0")]);
    const assets = assetsOf([pkg("A", "1.0.0", [shared]), pkg("B", "1.0.0", [shared])]);
    assert.equal(hasMtpCoveragePackageInAssets(assets), true);
  });
});

describe("platformMajor", () => {
  it("reads the resolved platform major from any depth", () => {
    const assets = assetsOf([pkg("TUnit", "0.90.45", [pkg("Microsoft.Testing.Platform", "2.3.0")])]);
    assert.equal(platformMajor(assets), 2);
  });

  it("does not confuse the platform with packages built on it", () => {
    const assets = assetsOf([pkg("Microsoft.Testing.Platform.MSBuild", "1.9.1")]);
    assert.equal(platformMajor(assets), undefined);
  });

  it("returns undefined when absent or unparsable", () => {
    assert.equal(platformMajor(assetsOf([])), undefined);
    assert.equal(platformMajor(assetsOf([pkg("Microsoft.Testing.Platform", "nonsense")])), undefined);
    assert.equal(platformMajor(assetsOf([pkg("Microsoft.Testing.Platform")])), undefined);
  });
});

describe("coverageExtensionMajor", () => {
  it("maps the known platform majors", () => {
    assert.equal(coverageExtensionMajor(1), 17);
    assert.equal(coverageExtensionMajor(2), 18);
  });

  it("refuses to guess for unknown or missing majors", () => {
    assert.equal(coverageExtensionMajor(3), undefined);
    assert.equal(coverageExtensionMajor(undefined), undefined);
  });
});

describe("pickVersionForMajor", () => {
  const versions = ["18.9.0", "18.0.4", "17.14.4", "17.10.0"];

  it("takes the newest version of the wanted major", () => {
    assert.equal(pickVersionForMajor(versions, 17), "17.14.4");
    assert.equal(pickVersionForMajor(versions, 18), "18.9.0");
  });

  it("returns undefined when no version matches", () => {
    assert.equal(pickVersionForMajor(versions, 16), undefined);
    assert.equal(pickVersionForMajor([], 18), undefined);
  });

  it("skips junk entries instead of throwing", () => {
    assert.equal(pickVersionForMajor(["", "not-a-version", "17.1.0"], 17), "17.1.0");
  });

  it("picks 17.x for an MTP v1 project (the version mismatch that broke the host)", () => {
    const assets = assetsOf([pkg("xunit.v3", "1.1.0", [pkg("Microsoft.Testing.Platform", "1.9.1")])]);
    const major = coverageExtensionMajor(platformMajor(assets));
    assert.equal(major, 17);
    assert.equal(pickVersionForMajor(versions, major as number), "17.14.4");
  });
});

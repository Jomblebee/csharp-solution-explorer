import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCatalogEntry } from "../../src/nuget/packageMetadata.js";

describe("parseCatalogEntry", () => {
  it("maps a full catalog entry, joining array authors and splitting string tags", () => {
    const meta = parseCatalogEntry({
      id: "Serilog",
      version: "3.1.1",
      description: "Simple .NET logging",
      summary: "logging",
      authors: ["Serilog Contributors"],
      iconUrl: "https://x/icon.png",
      projectUrl: "https://serilog.net",
      licenseExpression: "Apache-2.0",
      tags: "logging structured",
      listed: true,
      dependencyGroups: [
        { targetFramework: "net8.0", dependencies: [{ id: "A", range: "[1.0.0, )" }, { notId: true } as never] },
      ],
    });
    assert.equal(meta.authors, "Serilog Contributors");
    assert.deepEqual(meta.tags, ["logging", "structured"]);
    assert.equal(meta.licenseExpression, "Apache-2.0");
    assert.equal(meta.licenseUrl, undefined);
    assert.deepEqual(meta.dependencyGroups, [
      { targetFramework: "net8.0", dependencies: [{ id: "A", range: "[1.0.0, )" }] },
    ]);
  });

  it("maps a deprecation with its reasons and alternate package", () => {
    const meta = parseCatalogEntry({
      id: "X",
      deprecation: {
        reasons: ["Legacy", "Other"],
        message: "Use Y instead.",
        alternatePackage: { id: "Y" },
      },
    });
    assert.deepEqual(meta.deprecation, {
      reasons: ["Legacy", "Other"],
      message: "Use Y instead.",
      alternatePackageId: "Y",
    });
  });

  it("leaves deprecation undefined for a healthy package and tolerates a bare deprecation", () => {
    assert.equal(parseCatalogEntry({ id: "X" }).deprecation, undefined);
    assert.deepEqual(parseCatalogEntry({ id: "X", deprecation: {} }).deprecation, {
      reasons: [],
      message: undefined,
      alternatePackageId: undefined,
    });
  });

  it("maps vulnerabilities, accepting a numeric-string severity and dropping entries without a URL", () => {
    const meta = parseCatalogEntry({
      id: "X",
      vulnerabilities: [
        { advisoryUrl: "https://gh/advisory/1", severity: 2 },
        { advisoryUrl: "https://gh/advisory/2", severity: "3" },
        { severity: 1 } as never, // no advisoryUrl — the badge would have nothing to link to
      ],
    });
    assert.deepEqual(meta.vulnerabilities, [
      { advisoryUrl: "https://gh/advisory/1", severity: 2 },
      { advisoryUrl: "https://gh/advisory/2", severity: 3 },
    ]);
  });

  it("defaults an unparsable severity to zero rather than NaN", () => {
    const meta = parseCatalogEntry({
      id: "X",
      vulnerabilities: [{ advisoryUrl: "https://gh/a", severity: "high" }],
    });
    assert.deepEqual(meta.vulnerabilities, [{ advisoryUrl: "https://gh/a", severity: 0 }]);
  });

  it("defaults missing fields safely", () => {
    const meta = parseCatalogEntry({ id: "X" });
    assert.deepEqual(meta, {
      id: "X",
      version: "",
      description: "",
      summary: "",
      authors: "",
      iconUrl: undefined,
      projectUrl: undefined,
      licenseExpression: undefined,
      licenseUrl: undefined,
      tags: [],
      deprecation: undefined,
      vulnerabilities: [],
      dependencyGroups: [],
    });
  });
});

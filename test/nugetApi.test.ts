import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  parseCatalogEntry,
  parseSearchResponse,
  parseServiceIndex,
  parseServiceIndexByType,
  orderPagesForVersion,
  parseVersionsResponse,
  pickCatalogEntry,
} from "../src/nuget/nugetApi.js";

describe("parseSearchResponse", () => {
  it("maps each result, defaulting missing fields", () => {
    const json = {
      data: [
        {
          id: "Newtonsoft.Json",
          version: "13.0.3",
          description: "Json.NET",
          totalDownloads: 4200000000,
          verified: true,
          iconUrl: "https://x/icon.png",
        },
        { id: "Serilog" },
      ],
    };

    assert.deepEqual(parseSearchResponse(json), [
      {
        id: "Newtonsoft.Json",
        version: "13.0.3",
        description: "Json.NET",
        totalDownloads: 4200000000,
        verified: true,
        iconUrl: "https://x/icon.png",
        vulnerabilities: [],
      },
      {
        id: "Serilog",
        version: "",
        description: "",
        totalDownloads: 0,
        verified: false,
        iconUrl: undefined,
        vulnerabilities: [],
      },
    ]);
  });

  it("carries advisories through from a search hit", () => {
    const json = { data: [{ id: "X", vulnerabilities: [{ advisoryUrl: "https://gh/a", severity: 3 }] }] };
    assert.deepEqual(parseSearchResponse(json)[0].vulnerabilities, [
      { advisoryUrl: "https://gh/a", severity: 3 },
    ]);
  });

  it("drops entries without a string id", () => {
    const json = { data: [{ version: "1.0.0" }, { id: 42 }, { id: "Valid.Package" }] };
    assert.deepEqual(
      parseSearchResponse(json).map((p) => p.id),
      ["Valid.Package"],
    );
  });

  it("returns an empty list for a malformed response", () => {
    assert.deepEqual(parseSearchResponse({}), []);
    assert.deepEqual(parseSearchResponse(null), []);
    assert.deepEqual(parseSearchResponse({ data: "nope" }), []);
  });
});

describe("parseServiceIndex", () => {
  it("returns every SearchQueryService endpoint (incl. versioned types)", () => {
    const json = {
      resources: [
        { "@id": "https://api.nuget.org/v3-flatcontainer/", "@type": "PackageBaseAddress/3.0.0" },
        { "@id": "https://azuresearch-usnc.nuget.org/query", "@type": "SearchQueryService" },
        { "@id": "https://azuresearch-ussc.nuget.org/query", "@type": "SearchQueryService/3.5.0" },
      ],
    };

    assert.deepEqual(parseServiceIndex(json), [
      "https://azuresearch-usnc.nuget.org/query",
      "https://azuresearch-ussc.nuget.org/query",
    ]);
  });

  it("returns an empty list for a malformed response", () => {
    assert.deepEqual(parseServiceIndex({}), []);
    assert.deepEqual(parseServiceIndex({ resources: "nope" }), []);
  });
});

describe("parseServiceIndexByType", () => {
  it("matches any resource type starting with the prefix", () => {
    const json = {
      resources: [
        { "@id": "https://api.nuget.org/v3/registration5-gz-semver2/", "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": "https://azuresearch-usnc.nuget.org/query", "@type": "SearchQueryService" },
      ],
    };
    assert.deepEqual(parseServiceIndexByType(json, "RegistrationsBaseUrl/3.6.0"), [
      "https://api.nuget.org/v3/registration5-gz-semver2/",
    ]);
    assert.deepEqual(parseServiceIndexByType(json, "Nonexistent"), []);
  });
});

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

describe("orderPagesForVersion", () => {
  // Mirrors a real nuget.org index: several pages, none of them carrying inline items.
  const pages = [
    { "@id": "oldest", lower: "0.1.6", upper: "1.2.47" },
    { "@id": "middle", lower: "1.2.48", upper: "3.0.1" },
    { "@id": "newest", lower: "3.0.2", upper: "4.4.0" },
  ];

  it("puts the newest page first when no version is requested", () => {
    // Front-to-back order would land on the oldest page and report an ancient version as "latest".
    assert.deepEqual(
      orderPagesForVersion(pages).map((p) => p["@id"]),
      ["newest", "middle", "oldest"],
    );
  });

  it("puts the page whose range covers the requested version first", () => {
    assert.equal(orderPagesForVersion(pages, "2.10.0")[0]["@id"], "middle");
    assert.equal(orderPagesForVersion(pages, "0.5.0")[0]["@id"], "oldest");
    assert.equal(orderPagesForVersion(pages, "4.4.0")[0]["@id"], "newest");
  });

  it("includes the range boundaries themselves", () => {
    assert.equal(orderPagesForVersion(pages, "1.2.48")[0]["@id"], "middle");
    assert.equal(orderPagesForVersion(pages, "3.0.1")[0]["@id"], "middle");
  });

  it("keeps every page even when none covers the version, newest first", () => {
    assert.deepEqual(
      orderPagesForVersion(pages, "99.0.0").map((p) => p["@id"]),
      ["newest", "middle", "oldest"],
    );
  });

  it("does not drop pages without bounds, and does not mutate the input", () => {
    const unbounded = [{ "@id": "a" }, { "@id": "b", lower: "1.0.0", upper: "2.0.0" }];
    const original = [...unbounded];
    assert.equal(orderPagesForVersion(unbounded, "1.5.0")[0]["@id"], "b");
    assert.equal(orderPagesForVersion(unbounded).length, 2);
    assert.deepEqual(unbounded, original);
  });

  it("handles an empty index", () => {
    assert.deepEqual(orderPagesForVersion([]), []);
  });
});

describe("pickCatalogEntry", () => {
  const pages = [
    {
      items: [
        { catalogEntry: { id: "P", version: "1.0.0", listed: true } },
        { catalogEntry: { id: "P", version: "2.0.0", listed: true } },
        { catalogEntry: { id: "P", version: "2.1.0-beta", listed: true } },
        { catalogEntry: { id: "P", version: "0.9.0", listed: false } },
      ],
    },
  ];

  it("returns the newest listed stable entry when no version is requested", () => {
    assert.equal(pickCatalogEntry(pages)?.version, "2.0.0");
  });

  it("returns the exact requested version, including a prerelease", () => {
    assert.equal(pickCatalogEntry(pages, "2.1.0-beta")?.version, "2.1.0-beta");
    assert.equal(pickCatalogEntry(pages, "9.9.9"), undefined);
  });
});

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    assert.ok(compareVersions("9.0.0", "9.6.0") < 0);
    assert.ok(compareVersions("13.0.3", "13.0.1") > 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("treats differing segment counts as length-tolerant", () => {
    assert.equal(compareVersions("9.0", "9.0.0"), 0);
    assert.ok(compareVersions("9.0", "9.0.1") < 0);
  });

  it("sorts a pre-release below the stable release it precedes", () => {
    // Without this, anyone on a preview would never be offered the stable version.
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.0") < 0);
    assert.ok(compareVersions("9.0.0", "9.0.0-rc.1") > 0);
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.1") < 0);
    assert.ok(compareVersions("9.0.0-rc.1", "8.9.0") > 0);
  });

  it("orders pre-release labels per SemVer", () => {
    assert.equal(compareVersions("9.0.0-rc.1", "9.0.0-rc.1"), 0);
    assert.ok(compareVersions("9.0.0-alpha", "9.0.0-beta") < 0);
    assert.ok(compareVersions("9.0.0-rc.2", "9.0.0-rc.10") < 0); // numeric, not lexical
    assert.ok(compareVersions("9.0.0-rc.1", "9.0.0-rc.1.1") < 0); // longer label wins on a tie
    assert.ok(compareVersions("9.0.0-1", "9.0.0-alpha") < 0); // numeric sorts below alphanumeric
  });

  it("ignores build metadata", () => {
    assert.equal(compareVersions("9.0.0+build.5", "9.0.0"), 0);
    assert.equal(compareVersions("9.0.0-rc.1+build.5", "9.0.0-rc.1"), 0);
  });

  it("treats non-numeric segments as zero", () => {
    assert.equal(compareVersions("9.x", "9.0"), 0);
  });
});

describe("parseVersionsResponse", () => {
  it("returns versions newest-first", () => {
    assert.deepEqual(parseVersionsResponse({ versions: ["1.0.0", "1.1.0", "2.0.0"] }), [
      "2.0.0",
      "1.1.0",
      "1.0.0",
    ]);
  });

  it("ignores non-string entries", () => {
    assert.deepEqual(parseVersionsResponse({ versions: ["1.0.0", 2, null, "1.2.0"] }), ["1.2.0", "1.0.0"]);
  });

  it("returns an empty list for a malformed response", () => {
    assert.deepEqual(parseVersionsResponse({}), []);
    assert.deepEqual(parseVersionsResponse(undefined), []);
  });
});

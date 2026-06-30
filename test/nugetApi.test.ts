import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResponse, parseServiceIndex, parseVersionsResponse } from "../src/nuget/nugetApi.js";

describe("parseSearchResponse", () => {
  it("maps each result, defaulting missing fields", () => {
    const json = {
      data: [
        { id: "Newtonsoft.Json", version: "13.0.3", description: "Json.NET", totalDownloads: 4200000000, verified: true },
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
      },
      { id: "Serilog", version: "", description: "", totalDownloads: 0, verified: false },
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

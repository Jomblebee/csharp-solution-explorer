import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResponse, parseVersionsResponse } from "../../src/nuget/nugetApi.js";

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

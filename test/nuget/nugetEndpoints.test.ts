import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseServiceIndex, parseServiceIndexByType } from "../../src/nuget/nugetEndpoints.js";

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

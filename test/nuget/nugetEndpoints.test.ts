import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseServiceIndexByType } from "../../src/nuget/nugetEndpoints.js";

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

  it("returns every endpoint of a type, versioned suffixes included", () => {
    const json = {
      resources: [
        { "@id": "https://api.nuget.org/v3-flatcontainer/", "@type": "PackageBaseAddress/3.0.0" },
        { "@id": "https://azuresearch-usnc.nuget.org/query", "@type": "SearchQueryService" },
        { "@id": "https://azuresearch-ussc.nuget.org/query", "@type": "SearchQueryService/3.5.0" },
      ],
    };

    assert.deepEqual(parseServiceIndexByType(json, "SearchQueryService"), [
      "https://azuresearch-usnc.nuget.org/query",
      "https://azuresearch-ussc.nuget.org/query",
    ]);
  });

  it("returns an empty list for a malformed response", () => {
    assert.deepEqual(parseServiceIndexByType({}, "SearchQueryService"), []);
    assert.deepEqual(parseServiceIndexByType({ resources: "nope" }, "SearchQueryService"), []);
  });
});

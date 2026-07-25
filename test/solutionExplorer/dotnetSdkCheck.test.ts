import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSdk,
  formatWarning,
  isGlobalJsonSatisfied,
  parseGlobalJsonSdk,
  parseSdkVersion,
  requiredMajorFromTfms,
} from "../../src/solutionExplorer/dotnetSdkCheck.js";

describe("parseSdkVersion", () => {
  it("parses major.minor.patch", () => {
    assert.deepEqual(parseSdkVersion("9.0.100"), { major: 9, minor: 0, patch: 100 });
  });

  it("parses the leading version from a `dotnet --list-sdks` token", () => {
    assert.deepEqual(parseSdkVersion("8.0.401-preview"), { major: 8, minor: 0, patch: 401 });
  });

  it("returns undefined for non-version input", () => {
    assert.equal(parseSdkVersion("not-a-version"), undefined);
  });
});

describe("requiredMajorFromTfms", () => {
  it("returns the highest modern net major", () => {
    assert.equal(requiredMajorFromTfms(["net8.0", "net9.0"]), 9);
  });

  it("handles double-digit majors", () => {
    assert.equal(requiredMajorFromTfms(["net10.0"]), 10);
  });

  it("ignores netstandard, netcoreapp, net4x and MSBuild variables", () => {
    assert.equal(requiredMajorFromTfms(["netstandard2.0", "netcoreapp3.1", "net48", "$(Tfm)"]), undefined);
  });

  it("returns undefined for an empty list", () => {
    assert.equal(requiredMajorFromTfms([]), undefined);
  });
});

describe("parseGlobalJsonSdk", () => {
  it("reads sdk.version and rollForward", () => {
    const text = `{ "sdk": { "version": "8.0.100", "rollForward": "disable" } }`;
    assert.deepEqual(parseGlobalJsonSdk(text), { version: "8.0.100", rollForward: "disable" });
  });

  it("returns undefined when no sdk.version is pinned", () => {
    assert.equal(parseGlobalJsonSdk(`{ "sdk": {} }`), undefined);
    assert.equal(parseGlobalJsonSdk(`{}`), undefined);
  });

  it("returns undefined for invalid JSON", () => {
    assert.equal(parseGlobalJsonSdk(`{ not json`), undefined);
  });
});

describe("isGlobalJsonSatisfied", () => {
  it("is satisfied by a newer installed SDK under the default (roll-forward) policy", () => {
    assert.equal(isGlobalJsonSatisfied({ version: "8.0.100" }, ["8.0.401", "9.0.100"]), true);
  });

  it("is not satisfied when every installed SDK is older", () => {
    assert.equal(isGlobalJsonSatisfied({ version: "9.0.100" }, ["6.0.400", "8.0.100"]), false);
  });

  it("requires an exact match under rollForward: disable", () => {
    assert.equal(isGlobalJsonSatisfied({ version: "8.0.100", rollForward: "disable" }, ["8.0.200"]), false);
    assert.equal(isGlobalJsonSatisfied({ version: "8.0.100", rollForward: "disable" }, ["8.0.100"]), true);
  });

  it("is not satisfied when nothing is installed", () => {
    assert.equal(isGlobalJsonSatisfied({ version: "8.0.100" }, []), false);
  });
});

describe("evaluateSdk", () => {
  it("reports missing when no SDK is installed", () => {
    assert.deepEqual(evaluateSdk({ installedVersions: [], tfms: ["net8.0"] }), { kind: "missing" });
  });

  it("is ok when an installed major covers the target framework", () => {
    assert.deepEqual(evaluateSdk({ installedVersions: ["9.0.100"], tfms: ["net8.0"] }), { kind: "ok" });
  });

  it("flags a target framework newer than any installed SDK", () => {
    assert.deepEqual(evaluateSdk({ installedVersions: ["6.0.400"], tfms: ["net9.0"] }), {
      kind: "tfmUnsatisfied",
      requiredMajor: 9,
      installed: ["6.0.400"],
    });
  });

  it("flags an unsatisfied global.json pin before checking target frameworks", () => {
    assert.deepEqual(
      evaluateSdk({
        installedVersions: ["6.0.400"],
        globalJson: { version: "9.0.100" },
        tfms: ["net6.0"],
      }),
      { kind: "globalJsonUnsatisfied", requiredVersion: "9.0.100", installed: ["6.0.400"] },
    );
  });

  it("is ok for a solution with no resolvable requirement", () => {
    assert.deepEqual(evaluateSdk({ installedVersions: ["8.0.100"], tfms: ["netstandard2.0"] }), { kind: "ok" });
  });
});

describe("formatWarning", () => {
  it("returns undefined for an ok result", () => {
    assert.equal(formatWarning({ kind: "ok" }), undefined);
  });

  it("produces a message for each problem kind", () => {
    assert.match(formatWarning({ kind: "missing" }) ?? "", /No \.NET SDK found/);
    assert.match(
      formatWarning({ kind: "globalJsonUnsatisfied", requiredVersion: "9.0.100", installed: ["8.0.100"] }) ?? "",
      /global\.json requires .NET SDK 9\.0\.100/,
    );
    assert.match(
      formatWarning({ kind: "tfmUnsatisfied", requiredMajor: 9, installed: ["8.0.100"] }) ?? "",
      /targets \.NET 9/,
    );
  });
});

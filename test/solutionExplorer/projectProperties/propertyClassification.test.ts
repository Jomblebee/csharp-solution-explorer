import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyProperty } from "../../../src/solutionExplorer/projectProperties/propertyClassification.js";
import {
  PROPERTY_CATALOG,
  sdkDefaultFor,
} from "../../../src/solutionExplorer/projectProperties/propertyCatalog.js";
import { readDeclaration } from "../../../src/solutionExplorer/parsers/csprojPropertyScanner.js";
import type { Declaration } from "../../../src/solutionExplorer/parsers/csprojPropertyScanner.js";

const definition = (tag: string) => {
  const found = PROPERTY_CATALOG.find((entry) => entry.tag === tag);
  assert.ok(found, `${tag} is not in the catalogue`);
  return found;
};

const declared = (value: string, line = 3): Declaration => ({ state: "declared", line, value });

describe("classifyProperty — declared here", () => {
  it("is editable without waiting for MSBuild", () => {
    // The point: a value we can see in this file needs no evaluation to be safe to write.
    const status = classifyProperty({ definition: definition("Nullable"), declaration: declared("enable") });
    assert.equal(status.origin, "declared");
    assert.equal(status.editable, true);
    assert.equal(status.value, "enable");
    assert.equal(status.declaredLine, 3);
    assert.equal(status.canOverride, false);
  });

  it("shows the declared text and keeps the evaluation only as a hint", () => {
    const status = classifyProperty({
      definition: definition("NoWarn"),
      declaration: declared("$(NoWarn);NU1903"),
      evaluated: "NU1701;NU1903",
    });
    assert.equal(status.value, "$(NoWarn);NU1903");
    assert.equal(status.evaluated, "NU1701;NU1903");
  });

  it("warns about duplicate declarations", () => {
    const status = classifyProperty({
      definition: definition("Nullable"),
      declaration: { state: "declared", line: 7, value: "enable", duplicateLines: [3, 7] },
    });
    assert.deepEqual(status.duplicateLines, [3, 7]);
    assert.match(status.note ?? "", /2 times/);
  });
});

describe("classifyProperty — not editable", () => {
  it("locks a conditioned declaration and names the condition", () => {
    const status = classifyProperty({
      definition: definition("TreatWarningsAsErrors"),
      declaration: { state: "conditioned", lines: [5], conditions: ["'$(Configuration)'=='Release'"] },
      evaluated: "true",
    });
    assert.equal(status.origin, "conditioned");
    assert.equal(status.editable, false);
    assert.deepEqual(status.conditions, ["'$(Configuration)'=='Release'"]);
    assert.equal(status.value, "true");
  });

  it("locks a multi-line or CDATA value with a reason", () => {
    for (const reason of ["multiLine", "cdata", "unexpectedLocation"] as const) {
      const status = classifyProperty({
        definition: definition("NoWarn"),
        declaration: { state: "unwritable", line: 4, reason },
      });
      assert.equal(status.editable, false);
      assert.match(status.note ?? "", /Edit the project file directly/);
    }
  });
});

describe("classifyProperty — inherited", () => {
  it("reports a Directory.Build.props declaration with its path and line", () => {
    // The real TaskFlow fixture: NoWarn set once, centrally.
    const props = `<Project>
  <PropertyGroup>
    <!-- Suppress transitive SQLitePCLRaw advisory warning -->
    <NoWarn>$(NoWarn);NU1903</NoWarn>
  </PropertyGroup>
</Project>
`;
    const status = classifyProperty({
      definition: definition("NoWarn"),
      declaration: { state: "none" },
      ancestors: [{ fsPath: "/repo/Directory.Build.props", declaration: readDeclaration(props, "NoWarn") }],
    });
    assert.equal(status.origin, "inherited");
    assert.equal(status.editable, false, "an inherited value must not be silently writable");
    assert.equal(status.canOverride, true);
    assert.equal(status.inheritedFrom?.fsPath, "/repo/Directory.Build.props");
    assert.equal(status.inheritedFrom?.line, 3);
    assert.match(status.note ?? "", /Directory\.Build\.props/);
  });

  it("prefers the nearest ancestor that declares it", () => {
    const status = classifyProperty({
      definition: definition("Nullable"),
      declaration: { state: "none" },
      ancestors: [
        { fsPath: "/repo/src/Directory.Build.props", declaration: { state: "none" } },
        { fsPath: "/repo/Directory.Build.props", declaration: declared("enable", 2) },
      ],
    });
    assert.equal(status.inheritedFrom?.fsPath, "/repo/Directory.Build.props");
  });

  it("infers an import when MSBuild reports a value the SDK default does not explain", () => {
    const status = classifyProperty({
      definition: definition("TreatWarningsAsErrors"),
      declaration: { state: "none" },
      evaluated: "true",
      sdkDefault: "false",
    });
    assert.equal(status.origin, "inherited");
    assert.equal(status.editable, false);
    assert.match(status.note ?? "", /imported file/);
  });

  it("does not claim inheritance from a non-empty evaluation alone", () => {
    // Real case: MSBuild reports LangVersion 14.0 for a net10.0 project that declares nothing. The SDK
    // computed it from the framework, so calling it "inherited" would lock a field that is safe to edit.
    const status = classifyProperty({
      definition: definition("LangVersion"),
      declaration: { state: "none" },
      evaluated: "14.0",
    });
    assert.equal(status.origin, "default");
    assert.equal(status.editable, true);
    assert.match(status.note ?? "", /14\.0/);
  });
});

describe("classifyProperty — default and unknown", () => {
  it("is editable when MSBuild confirms the SDK default", () => {
    const status = classifyProperty({
      definition: definition("OutputType"),
      declaration: { state: "none" },
      evaluated: "Library",
      sdkDefault: "Library",
    });
    assert.equal(status.origin, "default");
    assert.equal(status.editable, true);
    assert.match(status.note ?? "", /Library/);
  });

  it("matches the SDK default case-insensitively", () => {
    const status = classifyProperty({
      definition: definition("GeneratePackageOnBuild"),
      declaration: { state: "none" },
      evaluated: "False",
      sdkDefault: "false",
    });
    assert.equal(status.origin, "default");
  });

  it("is editable when MSBuild reports nothing at all for the property", () => {
    const status = classifyProperty({
      definition: definition("Authors"),
      declaration: { state: "none" },
      evaluated: "",
    });
    assert.equal(status.origin, "default");
    assert.equal(status.editable, true);
  });

  it("stays locked while MSBuild has not answered", () => {
    const status = classifyProperty({ definition: definition("Nullable"), declaration: { state: "none" } });
    assert.equal(status.origin, "unknown");
    assert.equal(status.editable, false, "fail closed: provenance is unknown");
    assert.equal(status.canOverride, true, "but an explicit override must still be possible");
    assert.match(status.note ?? "", /Not verified/);
  });
});

describe("sdkDefaultFor", () => {
  it("makes OutputType depend on the SDK", () => {
    const outputType = definition("OutputType");
    assert.equal(sdkDefaultFor(outputType, "Microsoft.NET.Sdk"), "Library");
    assert.equal(sdkDefaultFor(outputType, "Microsoft.NET.Sdk.Web"), "Exe");
    assert.equal(sdkDefaultFor(outputType, "Microsoft.NET.Sdk.Worker"), "Exe");
    assert.equal(sdkDefaultFor(outputType, undefined), "Library");
  });

  it("passes other properties' declared defaults through", () => {
    assert.equal(sdkDefaultFor(definition("TreatWarningsAsErrors"), "Microsoft.NET.Sdk.Web"), "false");
    assert.equal(sdkDefaultFor(definition("Authors"), "Microsoft.NET.Sdk"), undefined);
  });
});

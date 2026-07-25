import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGetPropertyOutput } from "../../src/debug/projectOutput.js";

const jsonOutput = (props: Record<string, unknown>) => JSON.stringify({ Properties: props }, null, 2);

describe("parseGetPropertyOutput", () => {
  it("reads the multi-property JSON form", () => {
    const out = jsonOutput({ TargetPath: "/repo/bin/Debug/net10.0/App.dll", OutputType: "Exe" });

    assert.deepEqual(parseGetPropertyOutput(out), {
      TargetPath: "/repo/bin/Debug/net10.0/App.dll",
      OutputType: "Exe",
    });
  });

  it("keeps empty property values, which is how a multi-targeted project reports TargetPath", () => {
    // MSBuild returns an empty TargetPath rather than failing when the framework is ambiguous.
    assert.deepEqual(parseGetPropertyOutput(jsonOutput({ TargetPath: "", OutputType: "Exe" })), {
      TargetPath: "",
      OutputType: "Exe",
    });
  });

  it("reads the bare-string form MSBuild uses for a single property", () => {
    assert.deepEqual(parseGetPropertyOutput("/repo/bin/Debug/net10.0/App.dll\n", "TargetPath"), {
      TargetPath: "/repo/bin/Debug/net10.0/App.dll",
    });
  });

  it("returns undefined for a bare string when no property name is given to bind it to", () => {
    assert.equal(parseGetPropertyOutput("/repo/bin/Debug/net10.0/App.dll"), undefined);
  });

  it("returns undefined for empty output", () => {
    assert.equal(parseGetPropertyOutput(""), undefined);
    assert.equal(parseGetPropertyOutput("   \n  "), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(parseGetPropertyOutput("{ not json"), undefined);
  });

  it("returns undefined when the payload has no Properties object", () => {
    assert.equal(parseGetPropertyOutput(JSON.stringify({ Items: {} })), undefined);
    assert.equal(parseGetPropertyOutput(JSON.stringify({ Properties: [] })), undefined);
  });

  it("drops non-string property values instead of failing", () => {
    assert.deepEqual(parseGetPropertyOutput(jsonOutput({ TargetPath: "/a.dll", Weird: 42, Nested: {} })), {
      TargetPath: "/a.dll",
    });
  });
});

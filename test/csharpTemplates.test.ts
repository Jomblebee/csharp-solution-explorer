import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClassFileContent, buildNamespace } from "../src/solutionExplorer/csharpTemplates.js";

describe("buildNamespace", () => {
  it("uses just the project name when the target is the project root", () => {
    const result = buildNamespace("App", "/repo/App", "/repo/App");

    assert.equal(result, "App");
  });

  it("appends subfolder segments to the project name", () => {
    const result = buildNamespace("App", "/repo/App", "/repo/App/Models/Dto");

    assert.equal(result, "App.Models.Dto");
  });

  it("handles Windows-style backslash paths", () => {
    const result = buildNamespace("App", "C:\\repo\\App", "C:\\repo\\App\\Services");

    assert.equal(result, "App.Services");
  });

  it("falls back to just the project name when the target is outside the root", () => {
    const result = buildNamespace("App", "/repo/App", "/elsewhere/Foo");

    assert.equal(result, "App");
  });
});

describe("buildClassFileContent", () => {
  it("generates a file-scoped namespace and an empty public class", () => {
    const result = buildClassFileContent("App.Models", "Customer");

    assert.equal(result, "namespace App.Models;\n\npublic class Customer\n{\n}\n");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addProjectReference, removeProjectReference } from "../src/solutionExplorer/csprojWriter.js";
import { parseProjectReferences } from "../src/solutionExplorer/csprojReader.js";

describe("addProjectReference", () => {
  it("appends next to an existing ProjectReference in the same ItemGroup", () => {
    const csproj = [
      `<Project Sdk="Microsoft.NET.Sdk">`,
      `  <ItemGroup>`,
      `    <ProjectReference Include="..\\A\\A.csproj" />`,
      `  </ItemGroup>`,
      `</Project>`,
    ].join("\n");

    const result = addProjectReference(csproj, "..\\B\\B.csproj");

    assert.deepEqual(parseProjectReferences(result).map((r) => r.relativePath), ["../A/A.csproj", "../B/B.csproj"]);
    assert.match(result, /<ItemGroup>\n {4}<ProjectReference Include="\.\.\\A\\A\.csproj" \/>\n {4}<ProjectReference Include="\.\.\\B\\B\.csproj" \/>/);
  });

  it("creates a new ItemGroup before </Project> when none exists", () => {
    const csproj = [`<Project Sdk="Microsoft.NET.Sdk">`, `  <PropertyGroup />`, `</Project>`].join("\n");

    const result = addProjectReference(csproj, "..\\B\\B.csproj");

    assert.deepEqual(parseProjectReferences(result).map((r) => r.relativePath), ["../B/B.csproj"]);
    assert.match(result, /<ItemGroup>\n {4}<ProjectReference Include="\.\.\\B\\B\.csproj" \/>\n {2}<\/ItemGroup>\n<\/Project>/);
  });

  it("preserves CRLF line endings", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup />\r\n</Project>`;

    const result = addProjectReference(csproj, "..\\B\\B.csproj");

    assert.ok(result.includes("\r\n"));
    assert.ok(!/[^\r]\n/.test(result), "should not introduce bare LF line endings");
  });
});

describe("removeProjectReference", () => {
  it("removes the matching reference and cleans up the now-empty ItemGroup", () => {
    const csproj = [
      `<Project Sdk="Microsoft.NET.Sdk">`,
      `  <ItemGroup>`,
      `    <ProjectReference Include="..\\A\\A.csproj" />`,
      `  </ItemGroup>`,
      `</Project>`,
    ].join("\n");

    const result = removeProjectReference(csproj, "../A/A.csproj");

    assert.deepEqual(parseProjectReferences(result), []);
    assert.ok(!result.includes("<ItemGroup>"), "empty ItemGroup should be removed");
  });

  it("keeps sibling references and the ItemGroup", () => {
    const csproj = [
      `<Project Sdk="Microsoft.NET.Sdk">`,
      `  <ItemGroup>`,
      `    <ProjectReference Include="..\\A\\A.csproj" />`,
      `    <ProjectReference Include="..\\B\\B.csproj" />`,
      `  </ItemGroup>`,
      `</Project>`,
    ].join("\n");

    const result = removeProjectReference(csproj, "..\\A\\A.csproj");

    assert.deepEqual(parseProjectReferences(result).map((r) => r.relativePath), ["../B/B.csproj"]);
    assert.ok(result.includes("<ItemGroup>"));
  });

  it("matches slash-insensitively (backslash in file, forward-slash target)", () => {
    const csproj = [
      `<Project Sdk="Microsoft.NET.Sdk">`,
      `  <ItemGroup>`,
      `    <ProjectReference Include="..\\A\\A.csproj" />`,
      `  </ItemGroup>`,
      `</Project>`,
    ].join("\n");

    assert.deepEqual(parseProjectReferences(removeProjectReference(csproj, "../A/A.csproj")), []);
  });

  it("is a no-op when the reference is absent", () => {
    const csproj = [
      `<Project Sdk="Microsoft.NET.Sdk">`,
      `  <ItemGroup>`,
      `    <ProjectReference Include="..\\A\\A.csproj" />`,
      `  </ItemGroup>`,
      `</Project>`,
    ].join("\n");

    assert.equal(removeProjectReference(csproj, "..\\Z\\Z.csproj"), csproj);
  });
});

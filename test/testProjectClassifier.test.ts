import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTestProject } from "../src/testExplorer/testProjectClassifier.js";

describe("isTestProject", () => {
  it("detects a test-framework PackageReference", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup>
        <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />
        <PackageReference Include="xunit" Version="2.9.0" />
      </ItemGroup>
    </Project>`;
    assert.equal(isTestProject(csproj), true);
  });

  it("honours an explicit <IsTestProject>true", () => {
    assert.equal(isTestProject(`<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>`), true);
  });

  it("returns false for a plain library", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.0" /></ItemGroup>
    </Project>`;
    assert.equal(isTestProject(csproj), false);
  });
});

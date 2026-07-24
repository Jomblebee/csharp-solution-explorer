import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMtpProject } from "../src/testExplorer/mtpProjectClassifier.js";

describe("isMtpProject", () => {
  it("detects the MTP runner opt-in property", () => {
    assert.equal(
      isMtpProject(`<Project><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup></Project>`),
      true,
    );
  });

  it("detects an MTP-native package (xunit.v3)", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.2" /></ItemGroup>
    </Project>`;
    assert.equal(isMtpProject(csproj), true);
  });

  it("returns false for a classic VSTest xUnit v2 project", () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup>
        <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />
        <PackageReference Include="xunit" Version="2.9.0" />
      </ItemGroup>
    </Project>`;
    assert.equal(isMtpProject(csproj), false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveInstalledPackages } from "../src/nuget/installedView.js";

const csproj = (refs: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
${refs}
  </ItemGroup>
</Project>`;

const assets = (packages: Record<string, string>) =>
  JSON.stringify({
    version: 3,
    targets: {},
    libraries: {},
    project: {
      frameworks: {
        "net10.0": {
          dependencies: Object.fromEntries(
            Object.entries(packages).map(([name, version]) => [name, { target: "Package", version: `[${version}, )` }]),
          ),
        },
      },
    },
  });

describe("resolveInstalledPackages", () => {
  it("prefers the restore output over the project file", () => {
    const resolved = resolveInstalledPackages({
      assetsText: assets({ Serilog: "3.1.1" }),
      csprojText: csproj(`    <PackageReference Include="Serilog" Version="2.0.0" />`),
      centralVersions: [{ name: "Serilog", version: "1.0.0" }],
    });
    assert.deepEqual(resolved, [{ id: "Serilog", version: "3.1.1" }]);
  });

  it("falls back to the project file when there is no restore output", () => {
    const resolved = resolveInstalledPackages({
      csprojText: csproj(`    <PackageReference Include="Serilog" Version="2.0.0" />`),
      centralVersions: [{ name: "Serilog", version: "1.0.0" }],
    });
    assert.deepEqual(resolved, [{ id: "Serilog", version: "2.0.0" }]);
  });

  it("takes versions from Directory.Packages.props when the references carry none", () => {
    // Regression: under Central Package Management a not-yet-restored project used to report no
    // packages at all, because its <PackageReference> elements have no Version by design.
    const resolved = resolveInstalledPackages({
      csprojText: csproj(`    <PackageReference Include="Serilog" />
    <PackageReference Include="Newtonsoft.Json" />`),
      centralVersions: [
        { name: "Serilog", version: "3.1.1" },
        { name: "Newtonsoft.Json", version: "13.0.3" },
      ],
    });
    assert.deepEqual(resolved, [
      { id: "Serilog", version: "3.1.1" },
      { id: "Newtonsoft.Json", version: "13.0.3" },
    ]);
  });

  it("matches central versions case-insensitively", () => {
    const resolved = resolveInstalledPackages({
      csprojText: csproj(`    <PackageReference Include="Serilog" />`),
      centralVersions: [{ name: "serilog", version: "3.1.1" }],
    });
    assert.deepEqual(resolved, [{ id: "Serilog", version: "3.1.1" }]);
  });

  it("drops a reference with neither its own version nor a central one", () => {
    const resolved = resolveInstalledPackages({
      csprojText: csproj(`    <PackageReference Include="Serilog" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />`),
      centralVersions: [{ name: "Something.Else", version: "1.0.0" }],
    });
    assert.deepEqual(resolved, [{ id: "Newtonsoft.Json", version: "13.0.3" }]);
  });

  it("returns nothing when neither source is readable", () => {
    assert.deepEqual(resolveInstalledPackages({}), []);
  });

  it("treats unparsable restore output as an empty package list rather than falling through", () => {
    // parseProjectAssets returns EMPTY for malformed JSON; the assets file existing is still the
    // signal that this project has been restored, so we do not silently reinterpret the .csproj.
    assert.deepEqual(
      resolveInstalledPackages({
        assetsText: "{ not json",
        csprojText: csproj(`    <PackageReference Include="Serilog" Version="2.0.0" />`),
      }),
      [],
    );
  });
});

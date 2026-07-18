import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ancestorDirectories,
  decideCentralPackageManagement,
  parsePackagesProps,
} from "../src/nuget/centralPackageManagement.js";

describe("parsePackagesProps", () => {
  it("reads the flag and the pinned versions", () => {
    const props = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="3.1.1" />
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`;
    assert.deepEqual(parsePackagesProps(props), {
      enabled: true,
      versions: [
        { name: "Serilog", version: "3.1.1" },
        { name: "Newtonsoft.Json", version: "13.0.3" },
      ],
    });
  });

  it("treats the file as not centrally managed when the flag is absent or false", () => {
    // A repo may keep the file around with CPM switched off — that is not CPM.
    assert.equal(parsePackagesProps("<Project><ItemGroup /></Project>").enabled, false);
    const disabled = "<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>";
    assert.equal(parsePackagesProps(disabled).enabled, false);
  });

  it("accepts the flag in any casing and with surrounding whitespace", () => {
    const props = "<Project><ManagePackageVersionsCentrally>  TRUE  </ManagePackageVersionsCentrally></Project>";
    assert.equal(parsePackagesProps(props).enabled, true);
  });

  it("handles a non-self-closing PackageVersion and one without a version", () => {
    const props = `<Project>
  <PackageVersion Include="A" Version="1.0.0"></PackageVersion>
  <PackageVersion Include="B" />
  <PackageVersion Version="2.0.0" />
</Project>`;
    assert.deepEqual(parsePackagesProps(props).versions, [
      { name: "A", version: "1.0.0" },
      { name: "B", version: undefined },
    ]);
  });

  it("returns an empty result for an unrelated file", () => {
    assert.deepEqual(parsePackagesProps("<Project><NoWarn>NU1903</NoWarn></Project>"), {
      enabled: false,
      versions: [],
    });
  });
});

describe("ancestorDirectories", () => {
  it("walks up to the POSIX root", () => {
    assert.deepEqual(ancestorDirectories("/repo/src/App"), ["/repo/src/App", "/repo/src", "/repo", "/"]);
  });

  it("walks up to a Windows drive root, normalizing backslashes", () => {
    assert.deepEqual(ancestorDirectories("C:\\repo\\src"), ["C:/repo/src", "C:/repo", "C:"]);
  });

  it("ignores a trailing separator", () => {
    assert.deepEqual(ancestorDirectories("/repo/src/"), ["/repo/src", "/repo", "/"]);
  });

  it("terminates on the root itself and on a bare segment", () => {
    assert.deepEqual(ancestorDirectories("/"), ["/"]);
    assert.deepEqual(ancestorDirectories("repo"), ["repo"]);
    assert.deepEqual(ancestorDirectories(""), []);
  });
});

describe("decideCentralPackageManagement", () => {
  const enabled = (version: string) => `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>
  <ItemGroup><PackageVersion Include="Serilog" Version="${version}" /></ItemGroup>
</Project>`;
  const disabled = `<Project>
  <PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup>
</Project>`;

  it("lets the nearest props file win", () => {
    const info = decideCentralPackageManagement([
      { dir: "/repo/src/App", text: enabled("3.1.1") },
      { dir: "/repo", text: enabled("2.0.0") },
    ]);
    assert.equal(info?.propsPath, "/repo/src/App/Directory.Packages.props");
    assert.deepEqual(info?.versions, [{ name: "Serilog", version: "3.1.1" }]);
  });

  it("stops at a disabled file instead of consulting an enabled one further up", () => {
    // MSBuild imports exactly one props file; the nearest one turning CPM off means the project is
    // not centrally managed, not "keep looking".
    const info = decideCentralPackageManagement([
      { dir: "/repo/src/App", text: disabled },
      { dir: "/repo", text: enabled("2.0.0") },
    ]);
    assert.equal(info, undefined);
  });

  it("skips directories without the file and uses an ancestor's", () => {
    const info = decideCentralPackageManagement([
      { dir: "/repo/src/App", text: undefined },
      { dir: "/repo/src", text: undefined },
      { dir: "/repo", text: enabled("2.0.0") },
    ]);
    assert.equal(info?.propsPath, "/repo/Directory.Packages.props");
  });

  it("returns undefined when no directory has the file", () => {
    assert.equal(decideCentralPackageManagement([{ dir: "/repo", text: undefined }]), undefined);
    assert.equal(decideCentralPackageManagement([]), undefined);
  });
});

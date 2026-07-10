import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nupkgFileName,
  nupkgUrl,
  packageContentPrefix,
  packageId,
  parsePackageBaseAddress,
  serverEntry,
} from "../src/languageServer/roslynPackage.js";

describe("packageId / nupkgFileName", () => {
  it("uses canonical casing for the id and lowercases the file name", () => {
    assert.equal(packageId("linux-x64"), "Microsoft.CodeAnalysis.LanguageServer.linux-x64");
    assert.equal(
      nupkgFileName("linux-x64", "5.4.0-2.26080.13"),
      "microsoft.codeanalysis.languageserver.linux-x64.5.4.0-2.26080.13.nupkg",
    );
  });
});

describe("nupkgUrl", () => {
  const base = "https://pkgs.dev.azure.com/azure-public/x/y/nuget/v3/flat2/";

  it("builds a flat-container URL with lowercased id segments", () => {
    assert.equal(
      nupkgUrl(base, "linux-x64", "5.4.0-2.26080.13"),
      base +
        "microsoft.codeanalysis.languageserver.linux-x64/5.4.0-2.26080.13/" +
        "microsoft.codeanalysis.languageserver.linux-x64.5.4.0-2.26080.13.nupkg",
    );
  });

  it("tolerates a base address without a trailing slash", () => {
    const noSlash = base.slice(0, -1);
    assert.equal(nupkgUrl(noSlash, "win-x64", "1.0.0"), nupkgUrl(base, "win-x64", "1.0.0"));
  });
});

describe("parsePackageBaseAddress", () => {
  it("finds the PackageBaseAddress resource by @type prefix", () => {
    const json = {
      resources: [
        { "@id": "https://example/search", "@type": "SearchQueryService/3.5.0" },
        { "@id": "https://example/flat2/", "@type": "PackageBaseAddress/3.0.0" },
      ],
    };
    assert.equal(parsePackageBaseAddress(json), "https://example/flat2/");
  });

  it("returns undefined when absent or malformed", () => {
    assert.equal(parsePackageBaseAddress({ resources: [{ "@type": "SearchQueryService/3.0.0" }] }), undefined);
    assert.equal(parsePackageBaseAddress({}), undefined);
    assert.equal(parsePackageBaseAddress(null), undefined);
  });
});

describe("serverEntry", () => {
  it("selects a native .exe on Windows", () => {
    assert.deepEqual(serverEntry("win-x64"), {
      relPath: "Microsoft.CodeAnalysis.LanguageServer.exe",
      kind: "exe",
    });
  });

  it("selects a native apphost (no extension) on Linux", () => {
    assert.deepEqual(serverEntry("linux-x64"), {
      relPath: "Microsoft.CodeAnalysis.LanguageServer",
      kind: "exe",
    });
  });

  it("selects the DLL (dotnet exec) on macOS", () => {
    assert.deepEqual(serverEntry("osx-arm64"), {
      relPath: "Microsoft.CodeAnalysis.LanguageServer.dll",
      kind: "dll",
    });
  });
});

describe("packageContentPrefix", () => {
  it("points at the RID's content folder inside the nupkg", () => {
    assert.equal(packageContentPrefix("linux-x64"), "content/LanguageServer/linux-x64/");
  });
});

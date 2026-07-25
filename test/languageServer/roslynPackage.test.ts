import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  decideRazor,
  flatContainerNupkgUrl,
  nupkgFileName,
  nupkgUrl,
  packageContentPrefix,
  packageId,
  parsePackageBaseAddress,
  RAZOR_COHOST_MIN_SERVER_VERSION,
  razorLaunchPaths,
  resolveBaseAddressFrom,
  ROSLYN_LS_VERSION,
  serverEntry,
  serverSupportsRazorCohost,
  versionsToPrune,
} from "../../src/languageServer/roslynPackage.js";

describe("packageId / nupkgFileName", () => {
  it("uses the roslyn-language-server tool id (already lowercase)", () => {
    assert.equal(packageId("linux-x64"), "roslyn-language-server.linux-x64");
    assert.equal(
      nupkgFileName("linux-x64", "5.10.0-1.26359.5"),
      "roslyn-language-server.linux-x64.5.10.0-1.26359.5.nupkg",
    );
  });
});

describe("nupkgUrl", () => {
  const base = "https://api.nuget.org/v3-flatcontainer/";

  it("builds a flat-container URL with lowercased id segments", () => {
    assert.equal(
      nupkgUrl(base, "linux-x64", "5.10.0-1.26359.5"),
      base +
        "roslyn-language-server.linux-x64/5.10.0-1.26359.5/" +
        "roslyn-language-server.linux-x64.5.10.0-1.26359.5.nupkg",
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
  it("points at the RID's tool folder inside the nupkg", () => {
    assert.equal(packageContentPrefix("linux-x64"), "tools/net10.0/linux-x64/");
  });
});

describe("razorLaunchPaths", () => {
  it("maps the server dir to the two bundled cohost files Roslyn needs", () => {
    const dir = path.join("/cache", "roslyn", "5.10.0-1.26359.5", "linux-x64");
    assert.deepEqual(razorLaunchPaths(dir), {
      extensionDll: path.join(dir, "Microsoft.VisualStudioCode.RazorExtension.dll"),
      csharpDesignTimePath: path.join(dir, "Targets", "Microsoft.CSharpExtension.DesignTime.targets"),
    });
  });

  it("keeps flatContainerNupkgUrl consistent for the roslyn-language-server id", () => {
    const base = "https://api.nuget.org/v3-flatcontainer/";
    assert.equal(
      nupkgUrl(base, "linux-x64", "5.10.0-1.26359.5"),
      flatContainerNupkgUrl(base, "roslyn-language-server.linux-x64", "5.10.0-1.26359.5"),
    );
  });
});

describe("serverSupportsRazorCohost", () => {
  it("rejects cohost-incapable builds (older 5.x lines and other release lines)", () => {
    assert.equal(serverSupportsRazorCohost("5.5.0-2.26103.6"), false); // also on the new feed, pre-cohost
    assert.equal(serverSupportsRazorCohost("5.4.0-2.26179.14"), false);
    assert.equal(serverSupportsRazorCohost("5.0.0-2.26311.5"), false);
    // A newer *build date* on an older release line must not count as cohost-capable.
    assert.equal(serverSupportsRazorCohost("4.14.0-3.26358.10"), false);
    assert.equal(serverSupportsRazorCohost("4.12.0-3.26274.2"), false);
  });

  it("accepts the cohost-capable 5.8 / 5.9 / 5.10 lines at or above the minimum build", () => {
    assert.equal(serverSupportsRazorCohost("5.10.0-1.26359.5"), true); // pinned default
    assert.equal(serverSupportsRazorCohost(RAZOR_COHOST_MIN_SERVER_VERSION), true); // 5.8.0-1.26262.10
    assert.equal(serverSupportsRazorCohost("5.8.0-1.26262.10"), true);
    assert.equal(serverSupportsRazorCohost("5.8.0-2.26300.1"), true);
    assert.equal(serverSupportsRazorCohost("5.9.0-1.26303.1"), true); // still valid via a version override
    assert.equal(serverSupportsRazorCohost("5.10.0-1.26352.10"), true);
    assert.equal(serverSupportsRazorCohost("6.0.0-1.20000.1"), true);
  });

  it("rejects early 5.8 builds below the cohost minimum, and unparseable versions", () => {
    assert.equal(serverSupportsRazorCohost("5.8.0-1.26261.99"), false);
    assert.equal(serverSupportsRazorCohost("5.0.0-2-vs.25467.15"), false);
    assert.equal(serverSupportsRazorCohost("not-a-version"), false);
    assert.equal(serverSupportsRazorCohost(""), false);
  });

  // Guards against a future ROSLYN_LS_VERSION bump landing on a build *below* the cohost line, which
  // would silently drop Razor to highlighting-only for every user with no test failing.
  it("the pinned ROSLYN_LS_VERSION is cohost-capable", () => {
    assert.equal(serverSupportsRazorCohost(ROSLYN_LS_VERSION), true);
  });
});

describe("resolveBaseAddressFrom", () => {
  it("returns the first feed's base and does not touch later feeds", async () => {
    const seen: string[] = [];
    const base = await resolveBaseAddressFrom(["primary", "fallback"], async (url) => {
      seen.push(url);
      return `${url}-base`;
    });
    assert.equal(base, "primary-base");
    assert.deepEqual(seen, ["primary"]);
  });

  it("falls back to the next feed when the primary fails", async () => {
    const seen: string[] = [];
    const base = await resolveBaseAddressFrom(["primary", "fallback"], async (url) => {
      seen.push(url);
      if (url === "primary") {
        throw new Error("primary down");
      }
      return `${url}-base`;
    });
    assert.equal(base, "fallback-base");
    assert.deepEqual(seen, ["primary", "fallback"]);
  });

  it("rethrows the first (primary) error when every feed fails", async () => {
    const primaryError = new Error("primary down");
    await assert.rejects(
      resolveBaseAddressFrom(["primary", "fallback"], async (url) => {
        throw url === "primary" ? primaryError : new Error("fallback down");
      }),
      (err) => err === primaryError,
    );
  });
});

describe("decideRazor", () => {
  const version = ROSLYN_LS_VERSION; // cohost-capable
  const dir = path.join("/cache", "roslyn", version, "linux-x64");
  const allPresent = () => true;

  it("returns 'off' when Razor is disabled, without probing the server", () => {
    assert.deepEqual(decideRazor(false, version, dir, allPresent), { kind: "off" });
  });

  it("returns 'unavailable' with a 'predates' detail on a cohost-incapable server", () => {
    const decision = decideRazor(true, "5.4.0-2.26080.13", dir, allPresent);
    assert.equal(decision.kind, "unavailable");
    assert.match((decision as { detail: string }).detail, /predates Razor cohosting/);
    assert.match((decision as { detail: string }).detail, new RegExp(RAZOR_COHOST_MIN_SERVER_VERSION));
  });

  it("returns 'unavailable' listing the missing cohost file basenames", () => {
    const paths = razorLaunchPaths(dir);
    const fileExists = (p: string) => p !== paths.csharpDesignTimePath; // only the targets file missing
    const decision = decideRazor(true, version, dir, fileExists);
    assert.equal(decision.kind, "unavailable");
    const detail = (decision as { detail: string }).detail;
    assert.match(detail, /missing Razor cohost files/);
    assert.match(detail, /Microsoft\.CSharpExtension\.DesignTime\.targets/);
    assert.doesNotMatch(detail, /RazorExtension\.dll/); // that one exists, so it is not listed
  });

  it("returns 'loaded' with the bundled paths when the server is capable and files exist", () => {
    assert.deepEqual(decideRazor(true, version, dir, allPresent), {
      kind: "loaded",
      version,
      paths: razorLaunchPaths(dir),
    });
  });
});

describe("versionsToPrune", () => {
  it("keeps the active version and returns all the others", () => {
    assert.deepEqual(
      versionsToPrune(["5.9.0-1.26303.1", ROSLYN_LS_VERSION, "5.4.0-2.26080.13"], ROSLYN_LS_VERSION),
      ["5.9.0-1.26303.1", "5.4.0-2.26080.13"],
    );
  });

  it("returns nothing to prune when only the active version is present", () => {
    assert.deepEqual(versionsToPrune([ROSLYN_LS_VERSION], ROSLYN_LS_VERSION), []);
  });

  it("prunes everything when the version to keep is absent", () => {
    assert.deepEqual(versionsToPrune(["a", "b"], ROSLYN_LS_VERSION), ["a", "b"]);
  });

  it("handles an empty cache", () => {
    assert.deepEqual(versionsToPrune([], ROSLYN_LS_VERSION), []);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildServerLaunch, localServerKind } from "../src/languageServer/roslynServer.js";

describe("buildServerLaunch", () => {
  it("launches a native apphost directly over stdio", () => {
    assert.deepEqual(buildServerLaunch({ entryPath: "/srv/lsp", kind: "exe" }, "Information", "/logs"), {
      command: "/srv/lsp",
      args: ["--logLevel=Information", "--extensionLogDirectory", "/logs", "--stdio"],
      launch: "native",
    });
  });

  it("launches a DLL via `dotnet exec`", () => {
    assert.deepEqual(buildServerLaunch({ entryPath: "/srv/lsp.dll", kind: "dll" }, "Warning", "/logs"), {
      command: "dotnet",
      args: ["exec", "/srv/lsp.dll", "--logLevel=Warning", "--extensionLogDirectory", "/logs", "--stdio"],
      launch: "dotnet",
    });
  });
});

describe("localServerKind", () => {
  it("treats a .dll path as a dotnet-exec launch", () => {
    assert.equal(localServerKind("/opt/Microsoft.CodeAnalysis.LanguageServer.dll"), "dll");
    assert.equal(localServerKind("/opt/Server.DLL"), "dll");
  });

  it("treats anything else as a native executable", () => {
    assert.equal(localServerKind("/opt/Microsoft.CodeAnalysis.LanguageServer"), "exe");
    assert.equal(localServerKind("C:/srv/Microsoft.CodeAnalysis.LanguageServer.exe"), "exe");
  });
});

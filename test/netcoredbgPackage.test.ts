import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  archiveKind,
  assetName,
  binaryRelPath,
  buildAdapterExecutable,
  NETCOREDBG_VERSION,
  releaseAssetUrl,
  toDebugRid,
} from "../src/debug/netcoredbgPackage.js";

describe("toDebugRid", () => {
  it("passes through the four platforms with a published build", () => {
    assert.equal(toDebugRid("win-x64"), "win-x64");
    assert.equal(toDebugRid("linux-x64"), "linux-x64");
    assert.equal(toDebugRid("linux-arm64"), "linux-arm64");
    assert.equal(toDebugRid("osx-arm64"), "osx-arm64");
  });

  it("rejects Intel macOS and Windows on ARM, which have no published build", () => {
    assert.equal(toDebugRid("osx-x64"), undefined);
    assert.equal(toDebugRid("win-arm64"), undefined);
  });

  it("rejects an undetected platform", () => {
    assert.equal(toDebugRid(undefined), undefined);
  });
});

describe("assetName", () => {
  it("uses the upstream naming, which is not the .NET RID", () => {
    // x64 Linux is published as "amd64" and Windows as plain "win64".
    assert.equal(assetName("linux-x64"), "netcoredbg-linux-amd64.tar.gz");
    assert.equal(assetName("win-x64"), "netcoredbg-win64.zip");
  });

  it("names the arm64 assets", () => {
    assert.equal(assetName("linux-arm64"), "netcoredbg-linux-arm64.tar.gz");
    assert.equal(assetName("osx-arm64"), "netcoredbg-osx-arm64.zip");
  });
});

describe("archiveKind", () => {
  // The macOS asset switched from .tar.gz to .zip in 3.2.0, so this silently regresses on a bump.
  it("reports zip for macOS and Windows", () => {
    assert.equal(archiveKind("osx-arm64"), "zip");
    assert.equal(archiveKind("win-x64"), "zip");
  });

  it("reports tar.gz for Linux", () => {
    assert.equal(archiveKind("linux-x64"), "tar.gz");
    assert.equal(archiveKind("linux-arm64"), "tar.gz");
  });
});

describe("releaseAssetUrl", () => {
  it("builds a GitHub release download URL for the pinned version", () => {
    assert.equal(
      releaseAssetUrl("osx-arm64", NETCOREDBG_VERSION),
      `https://github.com/Samsung/netcoredbg/releases/download/${NETCOREDBG_VERSION}/netcoredbg-osx-arm64.zip`,
    );
  });

  it("honours an overridden version", () => {
    assert.equal(
      releaseAssetUrl("linux-x64", "3.1.3-1062"),
      "https://github.com/Samsung/netcoredbg/releases/download/3.1.3-1062/netcoredbg-linux-amd64.tar.gz",
    );
  });
});

describe("binaryRelPath", () => {
  it("adds the .exe suffix only on Windows", () => {
    assert.equal(binaryRelPath("win-x64"), "netcoredbg.exe");
    assert.equal(binaryRelPath("linux-x64"), "netcoredbg");
    assert.equal(binaryRelPath("osx-arm64"), "netcoredbg");
  });
});

describe("buildAdapterExecutable", () => {
  it("speaks DAP over stdio by default", () => {
    assert.deepEqual(buildAdapterExecutable("/opt/netcoredbg"), {
      command: "/opt/netcoredbg",
      args: ["--interpreter=vscode"],
    });
  });

  it("adds the trace log only when logging is on", () => {
    assert.deepEqual(buildAdapterExecutable("/opt/netcoredbg", true).args, ["--interpreter=vscode", "--log=file"]);
  });
});

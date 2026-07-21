// URLs and archive layout for netcoredbg, the OSS debug adapter (Samsung, MIT). It speaks the
// Debug Adapter Protocol natively (`--interpreter=vscode`), so we only download and launch it —
// no protocol implementation of our own. Pure: no `vscode`, no IO, so it stays unit-testable.

import { Rid } from "../languageServer/rid.js";

/**
 * Pinned release tag. Never resolve "latest": a new upstream release must not be able to change
 * what users get without a deliberate bump (same reasoning as `ROSLYN_LS_VERSION`).
 * Verified against 3.2.0-1092 — see the spike notes before bumping, and re-check `assetName`,
 * since the macOS asset switched from `.tar.gz` to `.zip` between 3.1.3 and 3.2.0.
 */
export const NETCOREDBG_VERSION = "3.2.0-1092";

/**
 * The platforms Samsung publishes a build for. Deliberately narrower than the language server's
 * `Rid`: there is no `osx-x64` (Intel Mac), no `win-arm64` and no musl build, so encoding the gap
 * in the type makes the compiler catch a missing case instead of producing a 404 at runtime.
 */
export type DebugRid = "win-x64" | "linux-x64" | "linux-arm64" | "osx-arm64";

/** Narrows a detected RID; `undefined` means no published build exists for this platform. */
export function toDebugRid(rid: Rid | undefined): DebugRid | undefined {
  switch (rid) {
    case "win-x64":
    case "linux-x64":
    case "linux-arm64":
    case "osx-arm64":
      return rid;
    default:
      // osx-x64, win-arm64, or an unsupported platform entirely.
      return undefined;
  }
}

/**
 * Asset file name in the GitHub release. Note the upstream naming does not follow .NET RIDs:
 * x64 Linux is `amd64` and Windows is just `win64`.
 */
export function assetName(rid: DebugRid): string {
  switch (rid) {
    case "win-x64":
      return "netcoredbg-win64.zip";
    case "linux-x64":
      return "netcoredbg-linux-amd64.tar.gz";
    case "linux-arm64":
      return "netcoredbg-linux-arm64.tar.gz";
    case "osx-arm64":
      return "netcoredbg-osx-arm64.zip";
  }
}

/** macOS and Windows ship ZIPs (yauzl handles those); only Linux needs tar.gz. */
export function archiveKind(rid: DebugRid): "zip" | "tar.gz" {
  return assetName(rid).endsWith(".zip") ? "zip" : "tar.gz";
}

export function releaseAssetUrl(rid: DebugRid, version: string): string {
  return `https://github.com/Samsung/netcoredbg/releases/download/${version}/${assetName(rid)}`;
}

/**
 * Every archive nests its contents in a single `netcoredbg/` directory. The whole directory must be
 * extracted, not just the executable: `libdbgshim.dylib`/`.so` and the managed `ManagedPart.dll`
 * sit next to it and are required at runtime.
 */
export const ARCHIVE_PREFIX = "netcoredbg/";

/** Path of the adapter executable relative to the extracted directory. */
export function binaryRelPath(rid: DebugRid): string {
  return rid.startsWith("win-") ? "netcoredbg.exe" : "netcoredbg";
}

/**
 * Builds the adapter command line. netcoredbg speaks DAP over stdio with `--interpreter=vscode`;
 * `--log=file` writes a trace next to the binary and is only enabled by the logging setting.
 */
export function buildAdapterExecutable(binaryPath: string, logging = false): { command: string; args: string[] } {
  const args = ["--interpreter=vscode"];
  if (logging) {
    args.push("--log=file");
  }
  return { command: binaryPath, args };
}

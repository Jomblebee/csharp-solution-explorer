// Runtime-identifier (RID) detection for the Roslyn language server download. The RID-specific
// server packages (Microsoft.CodeAnalysis.LanguageServer.{rid}) are ReadyToRun (precompiled for the
// platform) but framework-dependent — they require an installed .NET runtime, which the .NET SDK
// (already needed for this extension's Build/Run/NuGet features) provides. Kept as a pure function
// of platform/arch so it stays unit-testable.

export type Rid =
  | "win-x64"
  | "win-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "osx-x64"
  | "osx-arm64";

/**
 * Maps Node's `process.platform`/`process.arch` to a .NET RID, or `undefined` for an unsupported
 * combination. musl-based Linux (Alpine) is intentionally not distinguished here — it reports as
 * `linux` and would need a separate `linux-musl-*` package; that is a later addition.
 */
export function detectRid(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Rid | undefined {
  switch (platform) {
    case "win32":
      if (arch === "x64") {
        return "win-x64";
      }
      if (arch === "arm64") {
        return "win-arm64";
      }
      return undefined;
    case "linux":
      if (arch === "x64") {
        return "linux-x64";
      }
      if (arch === "arm64") {
        return "linux-arm64";
      }
      return undefined;
    case "darwin":
      if (arch === "x64") {
        return "osx-x64";
      }
      if (arch === "arm64") {
        return "osx-arm64";
      }
      return undefined;
    default:
      return undefined;
  }
}

// MSBuild worker-node lifetime for every `dotnet` process the extension spawns.
//
// A `dotnet build`/`test`/`msbuild` starts one MSBuild worker node per core, and with node reuse on
// (the SDK default) those nodes deliberately OUTLIVE the command that started them, waiting to be
// picked up by the next build. They are re-parented away from the extension host, so nothing here
// ever sees them exit. A node's resident set is whatever its last project needed — commonly
// 150-250 MB. An edit/build/test loop therefore stacks pool after pool: on a 20-core machine one
// build can leave ~19 processes behind, and an afternoon's worth reaches tens of GB.
//
// Reuse only pays off when the *next* build actually lands on the same pool, which an IDE's mix of
// concurrent builds, test runs and `-getProperty` evaluations frequently does not. So the extension
// opts out by default via `MSBUILDDISABLENODEREUSE=1` and the user can opt back in. The cost is
// roughly a second of node startup per build; the benefit is that a build's memory goes away with
// the build.
//
// Pure — no vscode — so the spawn-side modules stay unit-testable. The vscode layer pushes the
// settings in through `configureMsbuild` at activation and on every configuration change.

interface MsbuildSettings {
  /** Let MSBuild worker nodes survive the build that started them (the SDK default). */
  reuseNodes: boolean;
  /** Cap on parallel MSBuild nodes; 0 means "no cap — let MSBuild use every core". */
  maxCpuCount: number;
}

const DEFAULTS: MsbuildSettings = { reuseNodes: false, maxCpuCount: 0 };

let current: MsbuildSettings = { ...DEFAULTS };

export function configureMsbuild(settings: Partial<MsbuildSettings>): void {
  const max = settings.maxCpuCount;
  current = {
    reuseNodes: settings.reuseNodes ?? DEFAULTS.reuseNodes,
    // A garbage value from settings.json must not produce `-m:NaN`, which MSBuild rejects.
    maxCpuCount: typeof max === "number" && Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : DEFAULTS.maxCpuCount,
  };
}

/** Test seam: back to the defaults an unconfigured extension host would use. */
export function resetMsbuildConfig(): void {
  current = { ...DEFAULTS };
}

/**
 * Environment overrides to merge into every spawned `dotnet` process. Empty when the user has opted
 * into reuse, so their own `MSBUILDDISABLENODEREUSE` (if any) keeps deciding.
 */
export function msbuildNodeEnv(): NodeJS.ProcessEnv {
  return current.reuseNodes ? {} : { MSBUILDDISABLENODEREUSE: "1" };
}

/** `process.env` plus the node-reuse override, for spawns that pass no env of their own. */
export function msbuildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...msbuildNodeEnv() };
}

/**
 * The `-m:N` switch for command lines that take MSBuild arguments, or nothing when uncapped. Only
 * for `dotnet build`/`msbuild`: `dotnet test` on the .NET 10 SDK routes to Microsoft.Testing.Platform,
 * whose CLI rejects unknown switches outright.
 */
export function maxCpuArgs(): string[] {
  return current.maxCpuCount > 0 ? [`-m:${current.maxCpuCount}`] : [];
}

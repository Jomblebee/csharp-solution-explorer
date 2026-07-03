// Pure decision logic for the startup SDK check: what the open solution needs vs. what's installed,
// and the resulting warning text. Kept free of `vscode` imports so it can be unit-tested; the
// activation-time orchestration (file discovery, warning UI) lives in `dotnetSdkNotifier.ts`.

export interface SdkVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parses the leading `major.minor.patch` of an SDK version string (e.g. `9.0.100` or `8.0.401`). */
export function parseSdkVersion(version: string): SdkVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSdkVersions(a: SdkVersion, b: SdkVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The highest .NET SDK major version implied by a set of target framework monikers. Only modern
 * `net<major>.0` monikers (net5.0 and up) map cleanly to an SDK major; `netstandard*`, `netcoreapp*`,
 * classic `net4x`, and unresolved MSBuild variables (`$(...)`) are ignored. Returns undefined when
 * no moniker yields a requirement.
 */
export function requiredMajorFromTfms(tfms: string[]): number | undefined {
  let required: number | undefined;
  for (const tfm of tfms) {
    const match = /^net(\d+)\.\d+$/i.exec(tfm.trim());
    if (!match) {
      continue;
    }
    const major = Number(match[1]);
    if (major < 5) {
      continue;
    }
    if (required === undefined || major > required) {
      required = major;
    }
  }
  return required;
}

export interface GlobalJsonSdk {
  version: string;
  rollForward?: string;
}

/**
 * Reads the `sdk.version` (and optional `sdk.rollForward`) pin from a `global.json`. Returns
 * undefined when the file is not valid JSON or does not pin an SDK version.
 */
export function parseGlobalJsonSdk(text: string): GlobalJsonSdk | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const sdk = (parsed as { sdk?: { version?: unknown; rollForward?: unknown } } | null)?.sdk;
  if (!sdk || typeof sdk !== "object") {
    return undefined;
  }
  const version = typeof sdk.version === "string" ? sdk.version : undefined;
  if (!version) {
    return undefined;
  }
  const rollForward = typeof sdk.rollForward === "string" ? sdk.rollForward : undefined;
  return { version, rollForward };
}

/**
 * Whether the installed SDKs satisfy a `global.json` pin. Best-effort and deliberately lenient to
 * avoid false alarms: with `rollForward: disable` an exact major.minor.patch match is required;
 * otherwise any installed SDK at or above the pinned version (or a newer major) counts. An
 * unparseable pin is treated as satisfied.
 */
export function isGlobalJsonSatisfied(pin: GlobalJsonSdk, installedVersions: string[]): boolean {
  const required = parseSdkVersion(pin.version);
  if (!required) {
    return true;
  }
  const installed = installedVersions
    .map(parseSdkVersion)
    .filter((v): v is SdkVersion => v !== undefined);
  if (installed.length === 0) {
    return false;
  }
  if (pin.rollForward?.toLowerCase() === "disable") {
    return installed.some((v) => compareSdkVersions(v, required) === 0);
  }
  return installed.some((v) => v.major > required.major || compareSdkVersions(v, required) >= 0);
}

export type SdkCheckResult =
  | { kind: "ok" }
  | { kind: "missing" }
  | { kind: "globalJsonUnsatisfied"; requiredVersion: string; installed: string[] }
  | { kind: "tfmUnsatisfied"; requiredMajor: number; installed: string[] };

export interface SdkCheckInput {
  installedVersions: string[];
  globalJson?: GlobalJsonSdk;
  tfms: string[];
}

/** Pure decision logic: given what's installed and what the solution needs, what (if anything) is wrong. */
export function evaluateSdk({ installedVersions, globalJson, tfms }: SdkCheckInput): SdkCheckResult {
  if (installedVersions.length === 0) {
    return { kind: "missing" };
  }
  if (globalJson && !isGlobalJsonSatisfied(globalJson, installedVersions)) {
    return { kind: "globalJsonUnsatisfied", requiredVersion: globalJson.version, installed: installedVersions };
  }
  const requiredMajor = requiredMajorFromTfms(tfms);
  if (requiredMajor !== undefined) {
    const maxInstalledMajor = Math.max(
      0,
      ...installedVersions.map((v) => parseSdkVersion(v)?.major ?? 0),
    );
    if (maxInstalledMajor < requiredMajor) {
      return { kind: "tfmUnsatisfied", requiredMajor, installed: installedVersions };
    }
  }
  return { kind: "ok" };
}

/** The user-facing warning text for a check result, or undefined when nothing should be shown. */
export function formatWarning(result: SdkCheckResult): string | undefined {
  switch (result.kind) {
    case "ok":
      return undefined;
    case "missing":
      return "No .NET SDK found. Build, Run, Test, and package management require the .NET SDK.";
    case "globalJsonUnsatisfied":
      return `This solution's global.json requires .NET SDK ${result.requiredVersion}, which is not installed (found: ${result.installed.join(", ")}).`;
    case "tfmUnsatisfied":
      return `This solution targets .NET ${result.requiredMajor}, but no matching .NET SDK is installed (found: ${result.installed.join(", ")}).`;
  }
}

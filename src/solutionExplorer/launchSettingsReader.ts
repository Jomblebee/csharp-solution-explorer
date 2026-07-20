import * as path from "node:path";

/**
 * Reads a project's `Properties/launchSettings.json` — the same launch profiles Visual Studio shows
 * in its run dropdown, and the file `dotnet run --launch-profile` reads. Parsing is pure JSON (no
 * MSBuild, no vscode dependency) so it stays unit-testable.
 *
 * `resolveLaunchProfile` turns a profile into the environment/arguments a process needs. The run
 * command does not use it today (the `dotnet` CLI applies the profile itself), but a debugger
 * launches the built assembly directly and has to apply the profile on its own.
 */

/** Path of the launch settings file for a project, relative to its root directory. */
export function getLaunchSettingsPath(projectRootDir: string): string {
  return path.join(projectRootDir, "Properties", "launchSettings.json");
}

export interface LaunchProfile {
  name: string;
  /** As authored: `Project`, `IISExpress`, `Executable`, … See `isRunnableProfile`. */
  commandName: string;
  executablePath?: string;
  commandLineArgs?: string;
  workingDirectory?: string;
  applicationUrl?: string;
  launchUrl?: string;
  launchBrowser: boolean;
  dotnetRunMessages: boolean;
  environmentVariables: Record<string, string>;
}

export interface ParsedLaunchSettings {
  /** Profiles in the order they are authored; empty when the file is missing or malformed. */
  profiles: LaunchProfile[];
}

interface RawProfile {
  commandName?: unknown;
  executablePath?: unknown;
  commandLineArgs?: unknown;
  workingDirectory?: unknown;
  applicationUrl?: unknown;
  launchUrl?: unknown;
  launchBrowser?: unknown;
  dotnetRunMessages?: unknown;
  environmentVariables?: unknown;
}

const EMPTY: ParsedLaunchSettings = { profiles: [] };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Keeps only string-valued entries; VS only ever writes strings, but hand-edited files vary. */
function parseEnvironmentVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      result[key] = raw;
    }
  }
  return result;
}

/**
 * Parses a `launchSettings.json`. Never throws: malformed JSON, a missing `profiles` object, or a
 * profile that is not an object all degrade to "no profiles", which callers treat as "run plainly".
 */
export function parseLaunchSettings(jsonText: string): ParsedLaunchSettings {
  let data: { profiles?: unknown };
  try {
    // `dotnet new` writes this file with a UTF-8 BOM, which `JSON.parse` rejects. Callers decoding
    // bytes get it stripped for free, but a plain string read does not — so strip it here too.
    data = JSON.parse(stripBom(jsonText)) as { profiles?: unknown };
  } catch {
    return EMPTY;
  }

  const rawProfiles = data?.profiles;
  if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) {
    return EMPTY;
  }

  const profiles: LaunchProfile[] = [];
  for (const [name, raw] of Object.entries(rawProfiles as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const profile = raw as RawProfile;
    profiles.push({
      name,
      commandName: asString(profile.commandName) ?? "",
      executablePath: asString(profile.executablePath),
      commandLineArgs: asString(profile.commandLineArgs),
      workingDirectory: asString(profile.workingDirectory),
      applicationUrl: asString(profile.applicationUrl),
      launchUrl: asString(profile.launchUrl),
      // `dotnet run` prints its "Building..." messages unless a profile opts out, and only opens a
      // browser when a profile opts in — so the two defaults differ.
      launchBrowser: asBoolean(profile.launchBrowser, false),
      dotnetRunMessages: asBoolean(profile.dotnetRunMessages, true),
      environmentVariables: parseEnvironmentVariables(profile.environmentVariables),
    });
  }

  return { profiles };
}

/**
 * Whether `dotnet run --launch-profile` can drive this profile. Only `Project` starts the project
 * itself; `IISExpress` needs Windows-only tooling and `Executable`/`Docker` launch something else
 * entirely, so they are surfaced in the UI but not offered as a run target.
 */
export function isRunnableProfile(profile: LaunchProfile): boolean {
  return profile.commandName.toLowerCase() === "project";
}

/** The first runnable profile — the same choice the `dotnet` CLI makes when none is named. */
export function getDefaultProfile(settings: ParsedLaunchSettings): LaunchProfile | undefined {
  return settings.profiles.find(isRunnableProfile);
}

/** Case-insensitive lookup; undefined when the name is gone (a persisted selection went stale). */
export function findProfile(settings: ParsedLaunchSettings, name: string): LaunchProfile | undefined {
  const wanted = name.toLowerCase();
  return settings.profiles.find((p) => p.name.toLowerCase() === wanted);
}

export interface ResolvedLaunchProfile {
  /** The profile's variables, plus `ASPNETCORE_URLS` derived from `applicationUrl`. */
  env: Record<string, string>;
  args: string[];
  /** As authored — relative or absolute. Use `resolveWorkingDirectory` for an absolute path. */
  workingDirectory?: string;
  applicationUrls: string[];
  launchUrl?: string;
  launchBrowser: boolean;
  suppressRunMessages: boolean;
}

/**
 * Turns a profile into the pieces a process launch needs. `applicationUrl` becomes
 * `ASPNETCORE_URLS` (that is how the profile reaches ASP.NET Core), but an explicitly authored
 * `ASPNETCORE_URLS` wins — the profile author was more specific than we are.
 */
export function resolveLaunchProfile(profile: LaunchProfile): ResolvedLaunchProfile {
  const applicationUrls = splitApplicationUrls(profile.applicationUrl);
  const env = { ...profile.environmentVariables };
  if (applicationUrls.length > 0 && env.ASPNETCORE_URLS === undefined) {
    env.ASPNETCORE_URLS = applicationUrls.join(";");
  }

  return {
    env,
    args: parseCommandLineArgs(profile.commandLineArgs),
    workingDirectory: profile.workingDirectory,
    applicationUrls,
    launchUrl: profile.launchUrl,
    launchBrowser: profile.launchBrowser,
    suppressRunMessages: !profile.dotnetRunMessages,
  };
}

function splitApplicationUrls(applicationUrl: string | undefined): string[] {
  if (!applicationUrl) {
    return [];
  }
  return applicationUrl
    .split(";")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Splits a profile's `commandLineArgs` into argv. Double quotes group a token containing spaces and
 * are stripped, matching how the .NET SDK reads the field.
 */
export function parseCommandLineArgs(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quoted = false;
  let hasToken = false;

  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      // An empty "" is a deliberate empty argument, so remember that a token started.
      hasToken = true;
    } else if (!quoted && /\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) {
    args.push(current);
  }

  return args;
}

/** Absolute working directory for a profile; relative paths resolve against the project root. */
export function resolveWorkingDirectory(workingDirectory: string | undefined, projectRootDir: string): string {
  if (!workingDirectory) {
    return projectRootDir;
  }
  return path.isAbsolute(workingDirectory) ? workingDirectory : path.resolve(projectRootDir, workingDirectory);
}

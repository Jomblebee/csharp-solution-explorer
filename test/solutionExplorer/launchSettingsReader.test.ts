import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findProfile,
  getDefaultProfile,
  getLaunchSettingsPath,
  isRunnableProfile,
  parseCommandLineArgs,
  parseLaunchSettings,
  resolveLaunchProfile,
  resolveWorkingDirectory,
} from "../../src/solutionExplorer/launchSettingsReader.js";

const settings = (profiles: Record<string, unknown>) => JSON.stringify({ profiles });

const project = (overrides: Record<string, unknown> = {}) => ({ commandName: "Project", ...overrides });

/** Parses a single-profile file and returns that profile. */
const oneProfile = (raw: Record<string, unknown>) => {
  const parsed = parseLaunchSettings(settings({ Web: raw }));
  assert.equal(parsed.profiles.length, 1);
  return parsed.profiles[0];
};

describe("getLaunchSettingsPath", () => {
  it("points at Properties/launchSettings.json under the project root", () => {
    assert.equal(getLaunchSettingsPath("/repo/src/Web"), "/repo/src/Web/Properties/launchSettings.json");
  });
});

describe("parseLaunchSettings", () => {
  it("returns no profiles for invalid JSON", () => {
    assert.deepEqual(parseLaunchSettings("{ not json"), { profiles: [] });
  });

  it("returns no profiles when the profiles key is missing", () => {
    assert.deepEqual(parseLaunchSettings("{}"), { profiles: [] });
  });

  it("returns no profiles when profiles is not an object", () => {
    assert.deepEqual(parseLaunchSettings(JSON.stringify({ profiles: [] })), { profiles: [] });
  });

  it("tolerates the UTF-8 BOM that dotnet new writes", () => {
    const parsed = parseLaunchSettings(`﻿${settings({ http: project() })}`);

    assert.deepEqual(
      parsed.profiles.map((p) => p.name),
      ["http"],
    );
  });

  it("preserves the authored profile order", () => {
    const parsed = parseLaunchSettings(
      settings({ http: project(), https: project(), "IIS Express": { commandName: "IISExpress" } }),
    );

    assert.deepEqual(
      parsed.profiles.map((p) => p.name),
      ["http", "https", "IIS Express"],
    );
  });

  it("reads the profile fields", () => {
    const profile = oneProfile(
      project({
        commandLineArgs: "--verbose",
        workingDirectory: "bin",
        applicationUrl: "https://localhost:7123",
        launchUrl: "swagger",
        executablePath: "/usr/bin/app",
      }),
    );

    assert.equal(profile.commandName, "Project");
    assert.equal(profile.commandLineArgs, "--verbose");
    assert.equal(profile.workingDirectory, "bin");
    assert.equal(profile.applicationUrl, "https://localhost:7123");
    assert.equal(profile.launchUrl, "swagger");
    assert.equal(profile.executablePath, "/usr/bin/app");
  });

  it("defaults launchBrowser to false and dotnetRunMessages to true", () => {
    const profile = oneProfile(project());

    assert.equal(profile.launchBrowser, false);
    assert.equal(profile.dotnetRunMessages, true);
  });

  it("keeps authored launchBrowser and dotnetRunMessages values", () => {
    const profile = oneProfile(project({ launchBrowser: true, dotnetRunMessages: false }));

    assert.equal(profile.launchBrowser, true);
    assert.equal(profile.dotnetRunMessages, false);
  });

  it("keeps only string environment variable values", () => {
    const profile = oneProfile(
      project({ environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development", PORT: 5000, FLAG: null } }),
    );

    assert.deepEqual(profile.environmentVariables, { ASPNETCORE_ENVIRONMENT: "Development" });
  });

  it("treats a missing commandName as empty rather than failing", () => {
    const profile = oneProfile({ applicationUrl: "http://localhost:5000" });

    assert.equal(profile.commandName, "");
    assert.deepEqual(profile.environmentVariables, {});
  });

  it("skips profiles that are not objects", () => {
    const parsed = parseLaunchSettings(settings({ broken: "nope", http: project() }));

    assert.deepEqual(
      parsed.profiles.map((p) => p.name),
      ["http"],
    );
  });
});

describe("isRunnableProfile", () => {
  it("accepts a Project profile regardless of casing", () => {
    assert.equal(isRunnableProfile(oneProfile(project())), true);
    assert.equal(isRunnableProfile(oneProfile({ commandName: "project" })), true);
  });

  it("rejects IISExpress and Executable profiles", () => {
    assert.equal(isRunnableProfile(oneProfile({ commandName: "IISExpress" })), false);
    assert.equal(isRunnableProfile(oneProfile({ commandName: "Executable" })), false);
  });
});

describe("getDefaultProfile", () => {
  it("returns the first runnable profile, skipping a leading IISExpress entry", () => {
    const parsed = parseLaunchSettings(
      settings({ "IIS Express": { commandName: "IISExpress" }, http: project(), https: project() }),
    );

    assert.equal(getDefaultProfile(parsed)?.name, "http");
  });

  it("returns undefined when no profile is runnable", () => {
    const parsed = parseLaunchSettings(settings({ "IIS Express": { commandName: "IISExpress" } }));

    assert.equal(getDefaultProfile(parsed), undefined);
  });

  it("returns undefined for empty settings", () => {
    assert.equal(getDefaultProfile({ profiles: [] }), undefined);
  });
});

describe("findProfile", () => {
  it("matches a profile name case-insensitively", () => {
    const parsed = parseLaunchSettings(settings({ Https: project() }));

    assert.equal(findProfile(parsed, "https")?.name, "Https");
  });

  it("returns undefined for a name that no longer exists", () => {
    const parsed = parseLaunchSettings(settings({ http: project() }));

    assert.equal(findProfile(parsed, "https"), undefined);
  });
});

describe("parseCommandLineArgs", () => {
  it("returns no arguments for undefined or whitespace-only input", () => {
    assert.deepEqual(parseCommandLineArgs(undefined), []);
    assert.deepEqual(parseCommandLineArgs("   "), []);
  });

  it("splits on whitespace", () => {
    assert.deepEqual(parseCommandLineArgs("--verbose --count 3"), ["--verbose", "--count", "3"]);
  });

  it("keeps a double-quoted segment as one argument and strips the quotes", () => {
    assert.deepEqual(parseCommandLineArgs('--path "C:\\Program Files\\app" --flag'), [
      "--path",
      "C:\\Program Files\\app",
      "--flag",
    ]);
  });

  it("keeps an explicitly empty quoted argument", () => {
    assert.deepEqual(parseCommandLineArgs('--name ""'), ["--name", ""]);
  });
});

describe("resolveLaunchProfile", () => {
  it("resolves a full https profile", () => {
    const profile = oneProfile(
      project({
        commandLineArgs: "--seed",
        workingDirectory: "bin",
        applicationUrl: "https://localhost:7123;http://localhost:5123",
        launchUrl: "swagger",
        launchBrowser: true,
        dotnetRunMessages: false,
        environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" },
      }),
    );

    assert.deepEqual(resolveLaunchProfile(profile), {
      env: {
        ASPNETCORE_ENVIRONMENT: "Development",
        ASPNETCORE_URLS: "https://localhost:7123;http://localhost:5123",
      },
      args: ["--seed"],
      workingDirectory: "bin",
      applicationUrls: ["https://localhost:7123", "http://localhost:5123"],
      launchUrl: "swagger",
      launchBrowser: true,
      suppressRunMessages: true,
    });
  });

  it("does not overwrite an explicitly authored ASPNETCORE_URLS", () => {
    const profile = oneProfile(
      project({
        applicationUrl: "https://localhost:7123",
        environmentVariables: { ASPNETCORE_URLS: "http://localhost:9999" },
      }),
    );

    assert.equal(resolveLaunchProfile(profile).env.ASPNETCORE_URLS, "http://localhost:9999");
  });

  it("derives no urls when the profile has no applicationUrl", () => {
    const resolved = resolveLaunchProfile(oneProfile(project()));

    assert.deepEqual(resolved.applicationUrls, []);
    assert.equal(resolved.env.ASPNETCORE_URLS, undefined);
    assert.equal(resolved.suppressRunMessages, false);
  });
});

describe("resolveWorkingDirectory", () => {
  it("returns the project root when the profile has no working directory", () => {
    assert.equal(resolveWorkingDirectory(undefined, "/repo/src/Web"), "/repo/src/Web");
  });

  it("passes an absolute working directory through", () => {
    assert.equal(resolveWorkingDirectory("/srv/app", "/repo/src/Web"), "/srv/app");
  });

  it("resolves a relative working directory against the project root", () => {
    assert.equal(resolveWorkingDirectory("bin/Debug", "/repo/src/Web"), "/repo/src/Web/bin/Debug");
  });
});

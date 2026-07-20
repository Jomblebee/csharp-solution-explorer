import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchConfig, DEBUG_TYPE } from "../src/debug/debugConfig.js";
import type { ProjectOutput } from "../src/debug/projectOutput.js";
import type { ResolvedLaunchProfile } from "../src/solutionExplorer/launchSettingsReader.js";

const ROOT = "/repo/src/Web";

const output = (overrides: Partial<ProjectOutput> = {}): ProjectOutput => ({
  program: "/repo/src/Web/bin/Debug/net10.0/Web.dll",
  args: [],
  workingDirectory: ROOT,
  outputType: "Exe",
  targetFramework: "net10.0",
  ...overrides,
});

const profile = (overrides: Partial<ResolvedLaunchProfile> = {}): ResolvedLaunchProfile => ({
  env: {},
  args: [],
  workingDirectory: undefined,
  applicationUrls: [],
  launchUrl: undefined,
  launchBrowser: false,
  suppressRunMessages: false,
  ...overrides,
});

describe("buildLaunchConfig", () => {
  it("builds a launch body from MSBuild output alone", () => {
    assert.deepEqual(buildLaunchConfig({ name: "C#: Web", output: output(), projectRootDir: ROOT }), {
      type: DEBUG_TYPE,
      request: "launch",
      name: "C#: Web",
      program: "/repo/src/Web/bin/Debug/net10.0/Web.dll",
      args: [],
      cwd: ROOT,
      env: {},
      stopAtEntry: false,
      console: "internalConsole",
    });
  });

  it("passes the profile environment through, including the ASPNETCORE_URLS already folded in", () => {
    const config = buildLaunchConfig({
      name: "C#: Web",
      output: output(),
      projectRootDir: ROOT,
      profile: profile({
        env: { ASPNETCORE_ENVIRONMENT: "Development", ASPNETCORE_URLS: "https://localhost:7123" },
        applicationUrls: ["https://localhost:7123"],
      }),
    });

    assert.deepEqual(config.env, {
      ASPNETCORE_ENVIRONMENT: "Development",
      ASPNETCORE_URLS: "https://localhost:7123",
    });
  });

  it("prefers profile arguments over what MSBuild reports", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output({ args: ["--from-msbuild"] }),
      projectRootDir: ROOT,
      profile: profile({ args: ["--from-profile"] }),
    });

    assert.deepEqual(config.args, ["--from-profile"]);
  });

  it("falls back to MSBuild arguments when the profile has none", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output({ args: ["--from-msbuild"] }),
      projectRootDir: ROOT,
      profile: profile({ args: [] }),
    });

    assert.deepEqual(config.args, ["--from-msbuild"]);
  });

  it("lets explicit launch.json values outrank both the profile and MSBuild", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output({ args: ["--from-msbuild"] }),
      projectRootDir: ROOT,
      profile: profile({ args: ["--from-profile"], env: { A: "profile" }, workingDirectory: "bin" }),
      overrides: {
        args: ["--explicit"],
        cwd: "/elsewhere",
        env: { A: "explicit" },
        program: "/custom/App.dll",
      },
    });

    assert.deepEqual(config.args, ["--explicit"]);
    assert.equal(config.cwd, "/elsewhere");
    assert.equal(config.env.A, "explicit");
    assert.equal(config.program, "/custom/App.dll");
  });

  it("resolves a relative working directory from the profile against the project root", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output(),
      projectRootDir: ROOT,
      profile: profile({ workingDirectory: "bin/Debug" }),
    });

    assert.equal(config.cwd, "/repo/src/Web/bin/Debug");
  });

  it("uses the MSBuild working directory when the profile does not set one", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output({ workingDirectory: "/msbuild/cwd" }),
      projectRootDir: ROOT,
      profile: profile(),
    });

    assert.equal(config.cwd, "/msbuild/cwd");
  });

  it("carries stopAtEntry and console through", () => {
    const config = buildLaunchConfig({
      name: "n",
      output: output(),
      projectRootDir: ROOT,
      stopAtEntry: true,
      console: "integratedTerminal",
    });

    assert.equal(config.stopAtEntry, true);
    assert.equal(config.console, "integratedTerminal");
  });
});

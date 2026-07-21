import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AttachSpawnRequest,
  buildPosixWrapperScript,
  buildWindowsWrapperScript,
} from "../src/debug/externalTerminal/attachWrapperScript.js";

const req = (overrides: Partial<AttachSpawnRequest> = {}): AttachSpawnRequest => ({
  cwd: "/repo/src/Web",
  program: "/repo/src/Web/bin/Debug/net10.0/Web.dll",
  args: [],
  env: {},
  pidFilePath: "/tmp/cse-attach-abc/pid.txt",
  ...overrides,
});

describe("buildPosixWrapperScript", () => {
  it("cds, execs dotnet in the background, and writes the pidfile from $!", () => {
    const script = buildPosixWrapperScript(req());
    const lines = script.split("\n");
    assert.equal(lines[0], "#!/bin/bash");
    assert.equal(lines[2], "cd '/repo/src/Web'");
    assert.ok(script.includes("'dotnet' 'exec' '/repo/src/Web/bin/Debug/net10.0/Web.dll' &\n"));
    assert.ok(script.includes("\npid=$!\n"));
    assert.ok(script.includes("echo $pid > '/tmp/cse-attach-abc/pid.txt'\n"));
    assert.ok(script.includes("\nwait $pid\n"));
  });

  it("traps EXIT to remove the pidfile's own temp directory, before anything else runs", () => {
    const script = buildPosixWrapperScript(req());
    const lines = script.split("\n");
    assert.equal(lines[1], "trap 'rm -rf '\\''/tmp/cse-attach-abc'\\''' EXIT");
  });

  it("drops env entries whose name isn't a valid shell identifier", () => {
    const script = buildPosixWrapperScript(
      req({ env: { "A; touch pwned": "x", GOOD_NAME: "kept" } }),
    );
    assert.ok(!script.includes("touch pwned"));
    assert.ok(script.includes("export GOOD_NAME='kept'"));
  });

  it("never joins the background statement with `;` (bash syntax error after `&`)", () => {
    const script = buildPosixWrapperScript(req());
    assert.ok(!script.includes("&;"));
  });

  it("quotes args and env values containing spaces or quotes", () => {
    const script = buildPosixWrapperScript(
      req({ args: ["hello world", "it's fine"], env: { GREETING: "hi there" } }),
    );
    assert.ok(script.includes("export GREETING='hi there'"));
    assert.ok(script.includes("'hello world'"));
    assert.ok(script.includes("'it'\\''s fine'"));
  });

  it("omits the sleep line when startupDelayMs is not set", () => {
    assert.ok(!buildPosixWrapperScript(req()).includes("sleep"));
    assert.ok(!buildPosixWrapperScript(req({ startupDelayMs: 0 })).includes("sleep"));
  });

  it("adds a sleep line in seconds when startupDelayMs is set", () => {
    const script = buildPosixWrapperScript(req({ startupDelayMs: 300 }));
    assert.ok(script.includes("\nsleep 0.300\n"));
  });

  it("skips the keypress pause and exits immediately when killed by a signal (status >= 128)", () => {
    const script = buildPosixWrapperScript(req());
    assert.ok(script.includes("\nstatus=$?\nif [ $status -ge 128 ]; then\n  exit $status\nfi\n"));
    // The early `exit` must come before the pause, so a signal-killed run never reaches `read`.
    assert.ok(script.indexOf("if [ $status -ge 128 ]") < script.indexOf("read -r _"));
  });
});

describe("buildWindowsWrapperScript", () => {
  it("sets the working directory and starts dotnet via Start-Process -PassThru", () => {
    const script = buildWindowsWrapperScript(req());
    assert.ok(script.startsWith("try {\r\n  Set-Location -LiteralPath '/repo/src/Web'\r\n"));
    assert.ok(script.includes("Start-Process -FilePath 'dotnet' -ArgumentList @("));
    assert.ok(script.includes("-PassThru -NoNewWindow"));
    assert.ok(script.includes("$p.Id | Out-File -FilePath '/tmp/cse-attach-abc/pid.txt' -Encoding ascii\r\n"));
    assert.ok(script.includes("Wait-Process -Id $p.Id\r\n"));
  });

  it("wraps the body in try/finally so its own temp directory is removed on every exit path", () => {
    const script = buildWindowsWrapperScript(req());
    assert.ok(script.includes("\r\n} finally {\r\n"));
    assert.ok(
      script.trimEnd().endsWith(
        "  Remove-Item -LiteralPath '/tmp/cse-attach-abc' -Recurse -Force -ErrorAction SilentlyContinue\r\n}",
      ),
    );
  });

  it("drops env entries whose name isn't a valid PowerShell variable name", () => {
    const script = buildWindowsWrapperScript(
      req({ env: { "A; Remove-Item C:\\": "x", GOOD_NAME: "kept" } }),
    );
    assert.ok(!script.includes("Remove-Item C:\\"));
    assert.ok(script.includes("$env:GOOD_NAME = 'kept'"));
  });

  it("pre-quotes each argument for Win32 command-line rules before the PowerShell array", () => {
    const script = buildWindowsWrapperScript(req({ args: ["hello world"] }));
    assert.ok(script.includes(String.raw`'"hello world"'`));
  });

  it("sets environment variables via $env: before Start-Process", () => {
    const script = buildWindowsWrapperScript(req({ env: { ASPNETCORE_ENVIRONMENT: "Development" } }));
    assert.ok(script.includes("$env:ASPNETCORE_ENVIRONMENT = 'Development'\r\n"));
  });

  it("omits the sleep line when startupDelayMs is not set", () => {
    assert.ok(!buildWindowsWrapperScript(req()).includes("Start-Sleep"));
  });

  it("adds a Start-Sleep line in milliseconds when startupDelayMs is set", () => {
    const script = buildWindowsWrapperScript(req({ startupDelayMs: 300 }));
    assert.ok(script.includes("Start-Sleep -Milliseconds 300\r\n"));
  });
});

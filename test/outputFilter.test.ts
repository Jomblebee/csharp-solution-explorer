import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, createOutputFilter, QUIET_ENV } from "../src/testExplorer/outputFilter.js";

const ESC = String.fromCharCode(27);

describe("createOutputFilter", () => {
  it("passes everything through at the full level, escape sequences included", () => {
    const filter = createOutputFilter("full");
    const line = `${ESC}[32mPassed${ESC}[0m Ns.C.A [2 ms]`;
    assert.equal(filter(line), line);
    assert.equal(filter("  Determining projects to restore..."), "  Determining projects to restore...");
  });

  it("strips ANSI escape sequences below the full level", () => {
    const filter = createOutputFilter("normal");
    assert.equal(filter(`${ESC}[1G${ESC}[32mPassed${ESC}[0m Ns.C.A [2 ms]`), "Passed Ns.C.A [2 ms]");
  });

  it("keeps build diagnostics and host crashes at every level", () => {
    const filter = createOutputFilter("summary");
    assert.equal(filter("/repo/C.cs(12,5): error CS0103: The name 'x' does not exist"), "/repo/C.cs(12,5): error CS0103: The name 'x' does not exist");
    assert.equal(filter("/repo/C.cs(3,1): warning CS0219: unused"), "/repo/C.cs(3,1): warning CS0219: unused");
    assert.equal(filter("error MSB4025: The project file could not be loaded."), "error MSB4025: The project file could not be loaded.");
    assert.equal(filter("Unhandled exception. System.TypeLoadException: no."), "Unhandled exception. System.TypeLoadException: no.");
    assert.equal(filter("Unknown option --coverage"), "Unknown option --coverage");
  });

  it("drops restore, build and VSTest chrome", () => {
    const filter = createOutputFilter("normal");
    assert.equal(filter("  Determining projects to restore..."), undefined);
    assert.equal(filter("  Restored /repo/A.csproj (in 412 ms)."), undefined);
    assert.equal(filter("  A -> /repo/bin/Debug/net10.0/A.dll"), undefined);
    assert.equal(filter("Test run for /repo/bin/Debug/net10.0/A.dll (.NETCoreApp,Version=v10.0)"), undefined);
    assert.equal(filter("VSTest version 17.14.0 (x64)"), undefined);
    assert.equal(filter("Starting test execution, please wait..."), undefined);
    assert.equal(filter("A total of 1 test files matched the specified pattern."), undefined);
  });

  it("drops passing-test chatter only at the summary level", () => {
    assert.equal(createOutputFilter("normal")("  Passed Ns.C.A [2 ms]"), "  Passed Ns.C.A [2 ms]");
    assert.equal(createOutputFilter("summary")("  Passed Ns.C.A [2 ms]"), undefined);
    assert.equal(createOutputFilter("summary")("  Skipped Ns.C.B"), undefined);
    // Failures and the run's own verdict survive.
    assert.equal(createOutputFilter("summary")("  Failed Ns.C.C [4 ms]"), "  Failed Ns.C.C [4 ms]");
    assert.equal(createOutputFilter("summary")("Failed! - Failed: 1, Passed: 41, Skipped: 0"), "Failed! - Failed: 1, Passed: 41, Skipped: 0");
  });

  it("keeps only diagnostics and failures at the critical level, whatever the language", () => {
    const filter = createOutputFilter("critical");
    // Localized host chatter cannot be matched by a drop rule, so critical allows instead of denies.
    assert.equal(filter("Die Testsitzung wird gestartet."), undefined);
    assert.equal(filter('Verbindung mit Clienthost "127.0.0.1" Port "45183" wird hergestellt'), undefined);
    assert.equal(filter("Starting test session."), undefined);
    assert.equal(filter(""), undefined);
    assert.equal(filter("  Passed Ns.C.A [2 ms]"), undefined);
    assert.equal(filter("  Failed Ns.C.C [4 ms]"), "  Failed Ns.C.C [4 ms]");
    assert.equal(filter("/repo/C.cs(1,1): error CS0103: nope"), "/repo/C.cs(1,1): error CS0103: nope");
    assert.equal(filter("Unhandled exception. System.TypeLoadException: no."), "Unhandled exception. System.TypeLoadException: no.");
  });

  it("collapses runs of blank lines into one", () => {
    const filter = createOutputFilter("summary");
    assert.equal(filter(""), "");
    assert.equal(filter("   "), undefined);
    assert.equal(filter(""), undefined);
    assert.equal(filter("something"), "something");
    assert.equal(filter(""), "");
  });
});

describe("createLineSplitter", () => {
  it("emits whole lines across chunk boundaries and trims CR", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("one\r\ntw");
    splitter.push("o\nthree");
    assert.deepEqual(lines, ["one", "two"]);
    splitter.flush();
    assert.deepEqual(lines, ["one", "two", "three"]);
  });

  it("flushes nothing when the stream ended on a line boundary", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("only\n");
    splitter.flush();
    splitter.flush();
    assert.deepEqual(lines, ["only"]);
  });
});

describe("QUIET_ENV", () => {
  it("turns off the terminal logger, whose escape sequences the run terminal cannot replay", () => {
    assert.equal(QUIET_ENV.MSBUILDTERMINALLOGGER, "off");
    assert.equal(QUIET_ENV.NO_COLOR, "1");
  });
});

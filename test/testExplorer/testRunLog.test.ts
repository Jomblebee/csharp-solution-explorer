import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { headerLine, makeLogSink, mtpFailureMessage, summaryLine, writeLine } from "../../src/testExplorer/testRunLog.js";
import type { TrxOutcome, TrxTestResult } from "../../src/testExplorer/trxParser.js";

// `testRunLog` imports vscode as a type only and calls `run.appendOutput` on the object handed in, so
// a recorder object is all the "run" a test needs.
function fakeRun(): { run: vscode.TestRun; written: string[] } {
  const written: string[] = [];
  const run = { appendOutput: (text: string) => written.push(text) };
  return { run: run as unknown as vscode.TestRun, written };
}

function result(outcome: TrxOutcome, method: string): TrxTestResult {
  return { className: "Ns.C", method, outcome };
}

describe("writeLine", () => {
  it("appends the text with a CRLF ending, which the results panel requires", () => {
    const { run, written } = fakeRun();

    writeLine(run, "Building…");

    assert.deepEqual(written, ["Building…\r\n"]);
  });

  it("normalizes bare newlines inside the text", () => {
    const { run, written } = fakeRun();

    writeLine(run, "first\nsecond");

    assert.deepEqual(written, ["first\r\nsecond\r\n"]);
  });

  it("leaves an already-CRLF text alone", () => {
    const { run, written } = fakeRun();

    writeLine(run, "first\r\nsecond");

    assert.deepEqual(written, ["first\r\nsecond\r\n"]);
  });
});

describe("makeLogSink", () => {
  it("writes the lines the filter keeps and drops the rest", () => {
    const { run, written } = fakeRun();
    const sink = makeLogSink(run, "summary");

    sink("  Passed Ns.C.A [2 ms]");
    sink("  Failed Ns.C.C [4 ms]");

    assert.deepEqual(written, ["  Failed Ns.C.C [4 ms]\r\n"]);
  });

  it("keeps per-test chatter at the normal level", () => {
    const { run, written } = fakeRun();
    const sink = makeLogSink(run, "normal");

    sink("  Passed Ns.C.A [2 ms]");

    assert.deepEqual(written, ["  Passed Ns.C.A [2 ms]\r\n"]);
  });

  it("passes build diagnostics through at every level", () => {
    const { run, written } = fakeRun();
    const sink = makeLogSink(run, "summary");

    sink("/repo/C.cs(12,5): error CS0103: The name 'x' does not exist");

    assert.deepEqual(written, ["/repo/C.cs(12,5): error CS0103: The name 'x' does not exist\r\n"]);
  });

  it("gives each sink its own filter state, so runs do not share the blank-line collapse", () => {
    const first = fakeRun();
    const second = fakeRun();
    const sinkA = makeLogSink(first.run, "normal");
    const sinkB = makeLogSink(second.run, "normal");

    sinkA("");
    sinkA("");
    sinkB("");

    assert.deepEqual(first.written, ["\r\n"]);
    assert.deepEqual(second.written, ["\r\n"]);
  });
});

describe("headerLine", () => {
  it("names the framework when one is known", () => {
    assert.equal(headerLine("Tests.csproj", "xunit", "ALL"), "▶ Tests.csproj (xunit) — all tests");
  });

  it("omits the framework when there is none", () => {
    assert.equal(headerLine("Tests.csproj", undefined, "ALL"), "▶ Tests.csproj — all tests");
  });

  it("counts a selection, singular and plural", () => {
    assert.equal(headerLine("Tests.csproj", undefined, new Set(["a"])), "▶ Tests.csproj — 1 selected test");
    assert.equal(headerLine("Tests.csproj", undefined, new Set(["a", "b"])), "▶ Tests.csproj — 2 selected tests");
  });
});

describe("summaryLine", () => {
  it("counts the outcomes and reports the elapsed seconds", () => {
    const results = [
      result("Passed", "A"),
      result("Passed", "B"),
      result("Failed", "C"),
      result("NotExecuted", "D"),
      result("Other", "E"),
    ];

    assert.equal(summaryLine(results, 3210), "2 passed, 1 failed, 1 skipped in 3.2s");
  });

  it("reports zeros for a run without results", () => {
    assert.equal(summaryLine([], 0), "0 passed, 0 failed, 0 skipped in 0.0s");
  });
});

describe("mtpFailureMessage", () => {
  it("reports an empty project when the run itself succeeded", () => {
    assert.equal(mtpFailureMessage(true, "anything"), "No tests were found in this project.");
  });

  it("leads with the cause when the output names one", () => {
    const message = mtpFailureMessage(false, "Starting test session\nUnknown option --coverage\nBye");

    assert.equal(
      message,
      "Unknown option --coverage\nBye\n\nThe test run failed. See the 'C# Tests' output channel for the full log.",
    );
  });

  it("falls back to the bare pointer when there is no output to summarize", () => {
    assert.equal(
      mtpFailureMessage(false, "   \n\n"),
      "The test run failed. See the 'C# Tests' output channel for the full log.",
    );
  });
});

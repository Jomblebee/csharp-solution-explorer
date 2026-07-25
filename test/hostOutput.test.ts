import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTailBuffer, summarizeHostFailure } from "../src/testExplorer/hostOutput.js";

describe("createTailBuffer", () => {
  it("returns everything while under the cap", () => {
    const tail = createTailBuffer(100);
    tail.append("hello ");
    tail.append("world");
    assert.equal(tail.text(), "hello world");
  });

  it("keeps only the last characters once over the cap", () => {
    const tail = createTailBuffer(5);
    tail.append("abcdefgh");
    assert.equal(tail.text(), "defgh");
  });

  it("treats many small appends like one big one", () => {
    const tail = createTailBuffer(4);
    for (const ch of "abcdefg") {
      tail.append(ch);
    }
    assert.equal(tail.text(), "defg");
  });

  it("survives empty appends and a zero cap", () => {
    const tail = createTailBuffer(0);
    tail.append("");
    tail.append("noise");
    assert.equal(tail.text(), "");
  });
});

describe("summarizeHostFailure", () => {
  it("extracts the exception line and the frames under it", () => {
    const output = [
      "Building TaskFlow.Tests.XUnitV3…",
      "Unhandled exception. System.TypeLoadException: Could not load type 'IDataConsumer'",
      "   at Microsoft.Testing.Platform.MSBuild.MSBuildExtensions.AddMSBuild(ITestApplicationBuilder builder)",
      "   at SelfRegisteredExtensions.AddSelfRegisteredExtensions(ITestApplicationBuilder builder, String[] args)",
    ].join("\n");

    const summary = summarizeHostFailure(output);
    assert.ok(summary.startsWith("Unhandled exception. System.TypeLoadException"));
    assert.ok(summary.includes("AddSelfRegisteredExtensions"));
    assert.ok(!summary.includes("Building TaskFlow"));
  });

  it("picks up the platform's localized unknown-option message", () => {
    const output = 'xUnit.net v3 Microsoft.Testing.Platform v2 Runner v3.2.2\n\nUnbekannte Option "--coverage"\nNutzung dotnet exec …';
    assert.equal(summarizeHostFailure(output).split("\n")[0], 'Unbekannte Option "--coverage"');
  });

  it("falls back to the last lines when nothing looks like a failure", () => {
    const output = "one\ntwo\nthree\nfour";
    assert.equal(summarizeHostFailure(output, 2), "three\nfour");
  });

  it("caps the excerpt at maxLines", () => {
    const output = ["System.Exception: boom", "a", "b", "c"].join("\n");
    assert.equal(summarizeHostFailure(output, 2), "System.Exception: boom\na");
  });

  it("returns an empty string for empty or blank output", () => {
    assert.equal(summarizeHostFailure(""), "");
    assert.equal(summarizeHostFailure("  \n\n \r\n"), "");
  });
});

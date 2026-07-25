import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStackFrame } from "../../src/testExplorer/stackFrame.js";

describe("parseStackFrame", () => {
  it("reads file and line from a frame", () => {
    const trace = "   at TaskFlow.Tests.CalcTests.Adds() in /repo/tests/CalcTests.cs:line 18";
    assert.deepEqual(parseStackFrame(trace), { file: "/repo/tests/CalcTests.cs", line: 18 });
  });

  it("takes the topmost frame that has a location, skipping runner plumbing", () => {
    const trace = [
      "   at Xunit.Assert.Equal[T](T expected, T actual)",
      "   at TaskFlow.Tests.CalcTests.Adds() in /repo/tests/CalcTests.cs:line 18",
      "   at System.RuntimeMethodHandle.InvokeMethod() in /runtime/Invoke.cs:line 999",
    ].join("\n");
    assert.deepEqual(parseStackFrame(trace), { file: "/repo/tests/CalcTests.cs", line: 18 });
  });

  it("handles Windows paths and a localized 'line' keyword", () => {
    assert.deepEqual(parseStackFrame("   at C.M() in C:\\repo\\C.cs:Zeile 7"), { file: "C:\\repo\\C.cs", line: 7 });
  });

  it("returns undefined when there is nothing to locate", () => {
    assert.equal(parseStackFrame(undefined), undefined);
    assert.equal(parseStackFrame(""), undefined);
    assert.equal(parseStackFrame("   at Xunit.Assert.Equal[T](T expected, T actual)"), undefined);
  });
});

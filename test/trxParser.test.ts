import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrx } from "../src/testExplorer/trxParser.js";

const PASSING = `<?xml version="1.0" encoding="UTF-8"?>
<TestRun>
  <Results>
    <UnitTestResult testId="a1" testName="MyApp.Tests.CalcTests.Adds" outcome="Passed" duration="00:00:01.2340000" />
  </Results>
  <TestDefinitions>
    <UnitTest name="Adds" id="a1">
      <Execution id="e1" />
      <TestMethod className="MyApp.Tests.CalcTests" name="Adds" />
    </UnitTest>
  </TestDefinitions>
</TestRun>`;

const FAILING = `<TestRun>
  <Results>
    <UnitTestResult testId="b2" testName="MyApp.Tests.CalcTests.Fails" outcome="Failed" duration="00:00:00.0100000">
      <Output>
        <ErrorInfo>
          <Message>Assert.Equal() Failure: 1 &lt;&gt; 2</Message>
          <StackTrace>   at MyApp.Tests.CalcTests.Fails() in C:\\repo\\CalcTests.cs:line 10</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
  </Results>
  <TestDefinitions>
    <UnitTest name="Fails" id="b2">
      <TestMethod className="MyApp.Tests.CalcTests" name="Fails" />
    </UnitTest>
  </TestDefinitions>
</TestRun>`;

describe("parseTrx", () => {
  it("joins a passed result to its TestMethod definition", () => {
    const { results } = parseTrx(PASSING);
    assert.equal(results.length, 1);
    assert.deepEqual(
      { className: results[0].className, method: results[0].method, outcome: results[0].outcome },
      { className: "MyApp.Tests.CalcTests", method: "Adds", outcome: "Passed" },
    );
    assert.equal(results[0].durationMs, 1234);
  });

  it("extracts message and stack trace from a failed result", () => {
    const { results } = parseTrx(FAILING);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "Failed");
    assert.equal(results[0].message, "Assert.Equal() Failure: 1 <> 2");
    assert.match(results[0].stackTrace ?? "", /CalcTests\.cs:line 10/);
  });

  it("returns an empty summary for malformed or empty input", () => {
    assert.deepEqual(parseTrx("").results, []);
    assert.deepEqual(parseTrx("<not-a-trx/>").results, []);
  });
});

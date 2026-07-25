import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isActionNode, isTerminalState, mtpNodeToResult, mtpNodesToResults } from "../../src/testExplorer/mtpResults.js";
import type { MtpTestNode } from "../../src/testExplorer/mtpProtocol.js";

function node(partial: Partial<MtpTestNode> & { uid: string }): MtpTestNode {
  return { "display-name": partial.uid, "node-type": "action", ...partial } as MtpTestNode;
}

describe("mtpNodesToResults", () => {
  it("keeps the last state per uid and maps a pass with location", () => {
    const results = mtpNodesToResults([
      node({ uid: "t1", "execution-state": "discovered" }),
      node({ uid: "t1", "execution-state": "in-progress" }),
      node({
        uid: "t1",
        "execution-state": "passed",
        "time.duration-ms": 12.7,
        "location.type": "Ns.Tests",
        "location.method": "Adds",
        "location.file": "/repo/Tests.cs",
        "location.line-start": 10,
      }),
    ]);
    assert.equal(results.length, 1);
    assert.deepEqual(
      { c: results[0].className, m: results[0].method, o: results[0].outcome, d: results[0].durationMs, f: results[0].file, l: results[0].line },
      { c: "Ns.Tests", m: "Adds", o: "Passed", d: 13, f: "/repo/Tests.cs", l: 10 },
    );
  });

  it("joins a node's standard output and error, and stays undefined when it sends neither", () => {
    const [withOutput] = mtpNodesToResults([
      node({ uid: "o", "execution-state": "passed", "standard-output": " hello \n", "standard-error": "oops" }),
    ]);
    assert.equal(withOutput.stdout, "hello\noops");
    const [without] = mtpNodesToResults([node({ uid: "q", "execution-state": "passed" })]);
    assert.equal(without.stdout, undefined);
  });

  it("maps failed/timed-out/error to Failed and carries the error text", () => {
    const results = mtpNodesToResults([
      node({ uid: "f", "execution-state": "failed", "error.message": "boom", "error.stacktrace": "at X" }),
    ]);
    assert.equal(results[0].outcome, "Failed");
    assert.equal(results[0].message, "boom");
    assert.equal(results[0].stackTrace, "at X");
  });

  it("skips group nodes and non-terminal-only tests", () => {
    const results = mtpNodesToResults([
      node({ uid: "g", "node-type": "group", "execution-state": "passed" }),
      node({ uid: "pending", "execution-state": "in-progress" }),
    ]);
    assert.equal(results.length, 0);
  });

  it("derives className from the FQN when no location.type is present", () => {
    const results = mtpNodesToResults([
      node({ uid: "x", "execution-state": "skipped", "vstest.TestCase.FullyQualifiedName": "A.B.C.Method" }),
    ]);
    assert.equal(results[0].className, "A.B.C");
    assert.equal(results[0].outcome, "NotExecuted");
  });
});

describe("mtpNodeToResult / helpers", () => {
  it("maps a single node with location and duration", () => {
    const r = mtpNodeToResult(node({
      uid: "t", "execution-state": "passed", "time.duration-ms": 5.6,
      "location.type": "Ns.T", "location.method": "M", "location.file": "/a.cs", "location.line-start": 3,
    }));
    assert.deepEqual({ c: r.className, m: r.method, o: r.outcome, d: r.durationMs, l: r.line }, { c: "Ns.T", m: "M", o: "Passed", d: 6, l: 3 });
  });

  it("classifies action vs group and terminal vs non-terminal", () => {
    assert.equal(isActionNode(node({ uid: "a" })), true);
    assert.equal(isActionNode(node({ uid: "g", "node-type": "group" })), false);
    assert.equal(isTerminalState("passed"), true);
    assert.equal(isTerminalState("in-progress"), false);
    assert.equal(isTerminalState(undefined), false);
  });
});

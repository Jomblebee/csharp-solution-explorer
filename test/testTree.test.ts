import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classIdFor, groupByClass, methodIdFor } from "../src/testExplorer/testTree.js";
import type { TrxTestResult } from "../src/testExplorer/trxParser.js";

function result(className: string, method: string): TrxTestResult {
  return { className, method, outcome: "Passed" };
}

describe("groupByClass", () => {
  it("groups methods of the same class under one class node", () => {
    const tree = groupByClass("/repo/A.csproj", [
      result("Ns.Tests", "One"),
      result("Ns.Tests", "Two"),
    ]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].className, "Ns.Tests");
    assert.deepEqual(
      tree[0].methods.map((m) => m.method),
      ["One", "Two"],
    );
  });

  it("gives data-driven rows sharing a method name distinct ids", () => {
    const tree = groupByClass("/repo/A.csproj", [
      result("Ns.Tests", "Adds(a: 1)"),
      result("Ns.Tests", "Adds(a: 2)"),
    ]);
    const ids = tree[0].methods.map((m) => m.id);
    assert.equal(new Set(ids).size, 2);
  });

  it("embeds the project path in every id (no cross-project collisions)", () => {
    const tree = groupByClass("/repo/A.csproj", [result("Ns.Tests", "One")]);
    assert.equal(tree[0].id, "/repo/A.csproj::Ns.Tests");
    assert.equal(tree[0].methods[0].id, "/repo/A.csproj::Ns.Tests::One");
  });

  it("id helpers match the ids groupByClass produces", () => {
    const tree = groupByClass("/repo/A.csproj", [result("Ns.Tests", "One")]);
    assert.equal(classIdFor("/repo/A.csproj", "Ns.Tests"), tree[0].id);
    assert.equal(methodIdFor("/repo/A.csproj", "Ns.Tests", "One"), tree[0].methods[0].id);
  });
});

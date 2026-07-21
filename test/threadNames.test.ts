import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeThread, nameThreads } from "../src/debug/threadNames.js";

/** Stands in for /proc, so the rules are testable on any platform. */
const proc = (names: Record<number, string>) => (tid: number) => names[tid];
const noProc = () => undefined;

describe("describeThread", () => {
  it("keeps a name the user gave the thread", () => {
    assert.equal(describeThread({ id: 5, name: "Import worker" }, proc({ 5: ".NET TP Worker" })), "Import worker");
  });

  it("keeps netcoredbg's 'Main Thread', which beats the OS name 'dotnet'", () => {
    assert.equal(describeThread({ id: 100, name: "Main Thread" }, proc({ 100: "dotnet" })), "Main Thread");
  });

  it("replaces '<No name>' with the OS thread name and its id", () => {
    assert.equal(describeThread({ id: 228568, name: "<No name>" }, proc({ 228568: ".NET Finalizer" })), ".NET Finalizer (228568)");
  });

  it("appends the id because OS names repeat across threadpool workers", () => {
    const readComm = proc({ 1: ".NET TP Worker", 2: ".NET TP Worker" });
    assert.notEqual(describeThread({ id: 1, name: "<No name>" }, readComm), describeThread({ id: 2, name: "<No name>" }, readComm));
  });

  it("falls back to the bare id when the OS has no name (non-Linux, or the thread died)", () => {
    assert.equal(describeThread({ id: 228568, name: "<No name>" }, noProc), "Thread 228568");
  });

  it("treats an empty name like '<No name>'", () => {
    assert.equal(describeThread({ id: 7, name: "   " }, proc({ 7: ".NET Timer" })), ".NET Timer (7)");
  });

  it("leaves the name alone when the id is unusable", () => {
    assert.equal(describeThread({ id: -1, name: "<No name>" }, noProc), "<No name>");
    assert.equal(describeThread({ id: "abc", name: "<No name>" }, noProc), "<No name>");
    assert.equal(describeThread({ name: "<No name>" }, noProc), "<No name>");
  });

  it("names a thread that carries no name field at all", () => {
    assert.equal(describeThread({ id: 3 }, noProc), "Thread 3");
    assert.equal(describeThread({ id: 3 }, proc({ 3: ".NET Timer" })), ".NET Timer (3)");
  });

  it("returns undefined only when there is nothing to work with", () => {
    assert.equal(describeThread({}, noProc), undefined);
  });
});

describe("nameThreads", () => {
  it("rewrites the unnamed threads and keeps every other field", () => {
    const threads = [
      { id: 228524, name: "Main Thread" },
      { id: 228568, name: "<No name>" },
      { id: 228573, name: "<No name>" },
    ];
    const named = nameThreads(threads, proc({ 228568: ".NET Finalizer", 228573: ".NET TP Worker" }));
    assert.deepEqual(named, [
      { id: 228524, name: "Main Thread" },
      { id: 228568, name: ".NET Finalizer (228568)" },
      { id: 228573, name: ".NET TP Worker (228573)" },
    ]);
  });

  it("does not mutate the response it was given", () => {
    const threads = [{ id: 1, name: "<No name>" }];
    nameThreads(threads, proc({ 1: ".NET Timer" }));
    assert.deepEqual(threads, [{ id: 1, name: "<No name>" }]);
  });

  it("handles an empty thread list", () => {
    assert.deepEqual(nameThreads([], noProc), []);
  });
});

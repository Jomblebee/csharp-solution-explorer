import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePidFileContents } from "../../../src/debug/externalTerminal/attachPidFile.js";

describe("parsePidFileContents", () => {
  it("parses a plain integer", () => {
    assert.equal(parsePidFileContents("1234"), 1234);
  });

  it("trims trailing newlines and CRLF (Windows Out-File)", () => {
    assert.equal(parsePidFileContents("5678\r\n"), 5678);
    assert.equal(parsePidFileContents("5678\n"), 5678);
    assert.equal(parsePidFileContents("  5678  "), 5678);
  });

  it("rejects non-numeric content", () => {
    assert.equal(parsePidFileContents(""), undefined);
    assert.equal(parsePidFileContents("not a pid"), undefined);
    assert.equal(parsePidFileContents("123abc"), undefined);
  });

  it("rejects zero and negative numbers", () => {
    assert.equal(parsePidFileContents("0"), undefined);
    assert.equal(parsePidFileContents("-42"), undefined);
  });

  it("rejects decimals", () => {
    assert.equal(parsePidFileContents("12.5"), undefined);
  });
});

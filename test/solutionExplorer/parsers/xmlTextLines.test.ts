import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdits,
  buildXmlTextModel,
  detectNewline,
  diffRange,
  leadingIndent,
  lineEndWithTerminator,
  lineIndexAt,
  lineText,
} from "../../../src/solutionExplorer/parsers/xmlTextLines.js";

describe("buildXmlTextModel", () => {
  it("masks comment interiors without moving any offset", () => {
    const text = "<a>\n  <!-- <b>x</b> -->\n</a>\n";
    const model = buildXmlTextModel(text);
    assert.equal(model.masked.length, text.length, "the mask must be the same length as the text");
    assert.equal(model.masked.includes("<b>"), false);
    assert.equal(model.masked.includes("<!--"), true, "the delimiters stay, so the region is still not markup");
  });

  it("keeps line breaks inside a multi-line comment", () => {
    const model = buildXmlTextModel("<a>\n<!--\n<b/>\n-->\n</a>");
    assert.equal(model.lineStarts.length, 5);
    assert.equal(model.masked.includes("<b/>"), false);
  });

  it("masks an unterminated comment to the end of the file", () => {
    const model = buildXmlTextModel("<a>\n<!-- <b/>\n");
    assert.equal(model.masked.includes("<b/>"), false);
  });

  it("records CDATA ranges", () => {
    const text = "<a><![CDATA[ <b/> ]]></a>";
    const model = buildXmlTextModel(text);
    assert.equal(model.cdata.length, 1);
    assert.equal(model.masked.includes("<b/>"), false);
  });

  it("keeps offsets aligned past a non-BMP character in a comment", () => {
    // The trap: iterating code points instead of UTF-16 units would shift everything after the emoji.
    const text = "<a>\n<!-- 😀 -->\n<b>x</b>\n</a>";
    const model = buildXmlTextModel(text);
    assert.equal(model.masked.length, text.length);
    assert.equal(model.masked.indexOf("<b>"), text.indexOf("<b>"));
  });

  it("detects the dominant newline", () => {
    assert.equal(detectNewline("a\r\nb"), "\r\n");
    assert.equal(detectNewline("a\nb"), "\n");
  });
});

describe("line lookups", () => {
  const model = buildXmlTextModel("one\r\ntwo\r\nthree\r\n");

  it("finds the line containing an offset", () => {
    assert.equal(lineIndexAt(model, 0), 0);
    assert.equal(lineIndexAt(model, 5), 1);
    assert.equal(lineIndexAt(model, 12), 2);
  });

  it("returns line text without the terminator", () => {
    assert.equal(lineText(model, 1), "two");
  });

  it("returns the offset where the next line begins", () => {
    assert.equal(lineEndWithTerminator(model, 0), 5);
  });

  it("reads indentation of spaces and tabs only", () => {
    assert.equal(leadingIndent("  \t<a/>"), "  \t");
    assert.equal(leadingIndent("<a/>"), "");
  });
});

describe("applyEdits", () => {
  it("applies several non-overlapping edits back to front", () => {
    const text = "aaa bbb ccc";
    const result = applyEdits(text, [
      { range: { start: 0, end: 3 }, replacement: "X" },
      { range: { start: 8, end: 11 }, replacement: "Z" },
    ]);
    assert.equal(result, "X bbb Z");
  });

  it("handles an insertion, where start equals end", () => {
    assert.equal(applyEdits("ab", [{ range: { start: 1, end: 1 }, replacement: "-" }]), "a-b");
  });
});

describe("diffRange", () => {
  it("returns undefined for identical texts", () => {
    assert.equal(diffRange("same", "same"), undefined);
  });

  it("narrows a change to the one substring that differs", () => {
    // "enable" → "disable" shares the "able" suffix, so only "en" is replaced.
    const before = "<Nullable>enable</Nullable>";
    const after = "<Nullable>disable</Nullable>";
    const change = diffRange(before, after);
    assert.deepEqual(change, { range: { start: 10, end: 12 }, replacement: "dis" });
    assert.equal(before.slice(10, 12), "en");
  });

  it("describes a deletion as an empty replacement", () => {
    const change = diffRange("abcdef", "abef");
    assert.deepEqual(change, { range: { start: 2, end: 4 }, replacement: "" });
  });

  it("describes an insertion as a zero-width range", () => {
    const change = diffRange("abef", "abcdef");
    assert.deepEqual(change, { range: { start: 2, end: 2 }, replacement: "cd" });
  });

  it("round-trips: applying the change reproduces the target", () => {
    const cases: [string, string][] = [
      ["", "x"],
      ["x", ""],
      ["aaa", "aba"],
      ["line1\nline2\n", "line1\nline2\nline3\n"],
      ["<a>\n  <b>1</b>\n</a>", "<a>\n</a>"],
    ];
    for (const [before, after] of cases) {
      const change = diffRange(before, after);
      const applied = change ? applyEdits(before, [change]) : before;
      assert.equal(applied, after);
    }
  });
});

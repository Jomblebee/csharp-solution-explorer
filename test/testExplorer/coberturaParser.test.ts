import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeLineHits, parseCobertura } from "../../src/testExplorer/coberturaParser.js";

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.5" version="1.9">
  <packages>
    <package name="MyApp">
      <classes>
        <class name="MyApp.Calc" filename="/repo/src/Calc.cs">
          <lines>
            <line number="10" hits="3" branch="false" />
            <line number="11" hits="0" branch="false" />
            <line number="12" hits="2" branch="true" condition-coverage="50% (1/2)">
              <conditions>
                <condition number="0" type="jump" coverage="50%" />
              </conditions>
            </line>
          </lines>
        </class>
        <class name="MyApp.Calc.Nested" filename="/repo/src/Calc.cs">
          <lines>
            <line number="10" hits="5" />
            <line number="20" hits="1" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

describe("parseCobertura", () => {
  it("groups lines by filename and merges classes that share a file", () => {
    const files = parseCobertura(SAMPLE);
    assert.equal(files.length, 1);
    assert.equal(files[0].file, "/repo/src/Calc.cs");
    assert.deepEqual(
      files[0].lines,
      [
        { line: 10, hits: 5 }, // max(3, 5) across the two classes
        { line: 11, hits: 0 },
        { line: 12, hits: 2 },
        { line: 20, hits: 1 },
      ],
    );
  });

  it("reads lines whether self-closing or wrapping a <conditions> block", () => {
    const files = parseCobertura(SAMPLE);
    const line12 = files[0].lines.find((l) => l.line === 12);
    assert.deepEqual(line12, { line: 12, hits: 2 });
  });

  it("fails open to an empty array for unparseable input", () => {
    assert.deepEqual(parseCobertura("not xml at all"), []);
    assert.deepEqual(parseCobertura(""), []);
  });

  it("skips a class element with no filename", () => {
    const xml = `<class name="X"><lines><line number="1" hits="1" /></lines></class>`;
    assert.deepEqual(parseCobertura(xml), []);
  });
});

describe("mergeLineHits", () => {
  it("keeps the highest hit count per line", () => {
    assert.deepEqual(
      mergeLineHits(
        [
          { line: 1, hits: 4 },
          { line: 2, hits: 0 },
        ],
        [
          { line: 1, hits: 1 },
          { line: 2, hits: 7 },
        ],
      ),
      [
        { line: 1, hits: 4 },
        { line: 2, hits: 7 },
      ],
    );
  });

  it("unions lines only one side knows about, in line order", () => {
    assert.deepEqual(
      mergeLineHits([{ line: 30, hits: 1 }], [
        { line: 10, hits: 2 },
        { line: 20, hits: 0 },
      ]),
      [
        { line: 10, hits: 2 },
        { line: 20, hits: 0 },
        { line: 30, hits: 1 },
      ],
    );
  });

  it("returns the other side unchanged when one is empty", () => {
    const lines = [{ line: 5, hits: 3 }];
    assert.deepEqual(mergeLineHits([], lines), lines);
    assert.deepEqual(mergeLineHits(lines, []), lines);
    assert.deepEqual(mergeLineHits([], []), []);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  removeProperty,
  setProperty,
  setTargetFrameworks,
} from "../../../src/solutionExplorer/parsers/csprojPropertyWriter.js";
import { readDeclaration } from "../../../src/solutionExplorer/parsers/csprojPropertyScanner.js";
import { parseTargetFrameworks } from "../../../src/solutionExplorer/parsers/csprojReader.js";

const project = (body: string) => `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n`;

const simple = project(`  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);

describe("setProperty — updating an existing declaration", () => {
  it("replaces only the value", () => {
    const result = setProperty(simple, "Nullable", "disable");
    assert.equal(result.outcome, "updated");
    assert.equal(result.text, simple.replace("<Nullable>enable</Nullable>", "<Nullable>disable</Nullable>"));
  });

  it("keeps indentation, attributes and a trailing comment on the line", () => {
    const text = project(`  <PropertyGroup>
\t\t<Nullable  xml:space="preserve">enable</Nullable>   <!-- keep me -->
  </PropertyGroup>`);
    const result = setProperty(text, "Nullable", "disable");
    assert.equal(result.outcome, "updated");
    assert.match(result.text, /\t\t<Nullable {2}xml:space="preserve">disable<\/Nullable> {3}<!-- keep me -->/);
  });

  it("preserves CRLF line endings", () => {
    const crlf = simple.replace(/\n/g, "\r\n");
    const result = setProperty(crlf, "Nullable", "disable");
    assert.equal(result.outcome, "updated");
    assert.ok(!/[^\r]\n/.test(result.text), "a bare LF appeared in a CRLF file");
  });

  it("edits the last unconditional declaration and reports the duplicates", () => {
    const text = project(`  <PropertyGroup>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const result = setProperty(text, "Nullable", "annotations");
    assert.deepEqual(result.duplicateLines, [2, 5]);
    assert.match(result.text, /<Nullable>disable<\/Nullable>/);
    assert.match(result.text, /<Nullable>annotations<\/Nullable>/);
  });

  it("gives a self-closing element a body, keeping its attributes", () => {
    const text = project(`  <PropertyGroup>\n    <Nullable xml:space="preserve" />\n  </PropertyGroup>`);
    const result = setProperty(text, "Nullable", "enable");
    assert.equal(result.outcome, "updated");
    assert.match(result.text, /<Nullable xml:space="preserve">enable<\/Nullable>/);
  });

  it("returns the input byte-identically when the value already matches", () => {
    const result = setProperty(simple, "Nullable", "enable");
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.text, simple);
  });

  it("treats surrounding whitespace in the file as the same value", () => {
    const text = project("  <PropertyGroup>\n    <Nullable> enable </Nullable>\n  </PropertyGroup>");
    const result = setProperty(text, "Nullable", "enable");
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.text, text);
  });

  it("escapes the value", () => {
    const result = setProperty(simple, "Nullable", `a & b < c > d`);
    assert.match(result.text, /<Nullable>a &amp; b &lt; c &gt; d<\/Nullable>/);
  });

  it("writes an MSBuild expression verbatim", () => {
    const result = setProperty(simple, "NoWarn", "$(NoWarn);NU1903");
    assert.match(result.text, /<NoWarn>\$\(NoWarn\);NU1903<\/NoWarn>/);
  });

  it("leaves an existing declaration alone with insertOnly", () => {
    const result = setProperty(simple, "Nullable", "disable", { insertOnly: true });
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.text, simple);
  });
});

describe("setProperty — inserting", () => {
  it("adds the property to the first unconditional group, matching sibling indentation", () => {
    const result = setProperty(simple, "LangVersion", "latest");
    assert.equal(result.outcome, "inserted");
    assert.match(result.text, /\n {4}<LangVersion>latest<\/LangVersion>\n {2}<\/PropertyGroup>/);
    assert.equal(readDeclaration(result.text, "LangVersion").state, "declared");
  });

  it("uses the group's own indentation when it has no children yet", () => {
    const result = setProperty(project("    <PropertyGroup>\n    </PropertyGroup>"), "Nullable", "enable");
    assert.match(result.text, /\n {6}<Nullable>enable<\/Nullable>\n {4}<\/PropertyGroup>/);
  });

  it("appends inside a single-line group instead of breaking it apart", () => {
    const text = project("  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>");
    const result = setProperty(text, "Nullable", "enable");
    assert.equal(result.outcome, "inserted");
    assert.match(
      result.text,
      /<PropertyGroup><TargetFramework>net10\.0<\/TargetFramework><Nullable>enable<\/Nullable><\/PropertyGroup>/,
    );
  });

  it("skips a conditioned group and creates one of its own", () => {
    const text = project(`  <PropertyGroup Condition="'$(Configuration)'=='Release'">
    <Optimize>true</Optimize>
  </PropertyGroup>`);
    const result = setProperty(text, "Nullable", "enable");
    assert.equal(result.outcome, "createdGroup");
    assert.match(result.text, / {2}<PropertyGroup>\n {4}<Nullable>enable<\/Nullable>\n {2}<\/PropertyGroup>\n<\/Project>/);
    assert.equal(readDeclaration(result.text, "Optimize").state, "conditioned");
  });

  it("creates a PropertyGroup before </Project> when the file has none", () => {
    const result = setProperty("<Project Sdk=\"Microsoft.NET.Sdk\">\n</Project>\n", "Nullable", "enable");
    assert.equal(result.outcome, "createdGroup");
    assert.equal(
      result.text,
      '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n',
    );
  });

  it("keeps CRLF when creating a group", () => {
    const result = setProperty('<Project Sdk="Microsoft.NET.Sdk">\r\n</Project>\r\n', "Nullable", "enable");
    assert.ok(!/[^\r]\n/.test(result.text));
  });
});

describe("setProperty — refusals", () => {
  const assertRefused = (result: { outcome: string; text: string }, expected: string, input: string) => {
    assert.equal(result.outcome, expected);
    assert.equal(result.text, input, "a refusal must return the input untouched");
  };

  it("refuses a value containing a newline", () => {
    assertRefused(setProperty(simple, "Nullable", "a\nb"), "refusedInvalidValue", simple);
  });

  it("refuses when only a conditioned declaration exists, naming the condition", () => {
    const text = project(`  <PropertyGroup Condition="'$(Configuration)'=='Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>`);
    const result = setProperty(text, "TreatWarningsAsErrors", "false");
    assertRefused(result, "refusedConditioned", text);
    assert.deepEqual(result.blockingConditions, ["'$(Configuration)'=='Release'"]);
  });

  it("refuses a multi-line value", () => {
    const text = project("  <PropertyGroup>\n    <NoWarn>\n      NU1903\n    </NoWarn>\n  </PropertyGroup>");
    assertRefused(setProperty(text, "NoWarn", "NU1903"), "refusedMultiLine", text);
  });

  it("refuses a CDATA value", () => {
    const text = project("  <PropertyGroup>\n    <Banner><![CDATA[a > b]]></Banner>\n  </PropertyGroup>");
    assertRefused(setProperty(text, "Banner", "plain"), "refusedMultiLine", text);
  });

  it("refuses a malformed file", () => {
    const unbalanced = project("  <PropertyGroup>");
    assertRefused(setProperty(unbalanced, "Nullable", "enable"), "refusedMalformed", unbalanced);

    const noClose = '<Project Sdk="Microsoft.NET.Sdk">\n';
    assertRefused(setProperty(noClose, "Nullable", "enable"), "refusedMalformed", noClose);
  });

  it("refuses a property sitting outside any PropertyGroup rather than adding a second one", () => {
    const text = project("  <Nullable>enable</Nullable>");
    assertRefused(setProperty(text, "Nullable", "disable"), "refusedMalformed", text);
  });

  it("ignores a commented-out declaration and inserts a real one", () => {
    const text = project("  <PropertyGroup>\n    <!-- <Nullable>enable</Nullable> -->\n  </PropertyGroup>");
    const result = setProperty(text, "Nullable", "disable");
    assert.equal(result.outcome, "inserted");
    assert.match(result.text, /<!-- <Nullable>enable<\/Nullable> -->/);
    assert.equal(readDeclaration(result.text, "Nullable").state === "declared", true);
  });
});

describe("removeProperty", () => {
  it("removes the element and leaves its siblings", () => {
    const result = removeProperty(simple, "Nullable");
    assert.equal(result.outcome, "removed");
    assert.equal(
      result.text,
      project("  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>"),
    );
  });

  it("drops the PropertyGroup it emptied", () => {
    const text = project(`  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const result = removeProperty(text, "Nullable");
    assert.equal(
      result.text,
      project("  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>"),
    );
  });

  it("leaves a group the author had already left empty", () => {
    const text = project(`  <PropertyGroup>
  </PropertyGroup>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const result = removeProperty(text, "Nullable");
    assert.equal(result.text, project("  <PropertyGroup>\n  </PropertyGroup>"));
  });

  it("removes every unconditional duplicate", () => {
    const text = project(`  <PropertyGroup>
    <Nullable>disable</Nullable>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const result = removeProperty(text, "Nullable");
    assert.equal(readDeclaration(result.text, "Nullable").state, "none");
    assert.equal(readDeclaration(result.text, "TargetFramework").state, "declared");
  });

  it("keeps a conditioned declaration", () => {
    const text = project(`  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)'=='Release'">
    <Nullable>disable</Nullable>
  </PropertyGroup>`);
    const result = removeProperty(text, "Nullable");
    assert.equal(readDeclaration(result.text, "Nullable").state, "conditioned");
  });

  it("refuses when only a conditioned declaration exists", () => {
    const text = project(`  <PropertyGroup Condition="'$(X)'=='1'">
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const result = removeProperty(text, "Nullable");
    assert.equal(result.outcome, "refusedConditioned");
    assert.equal(result.text, text);
  });

  it("reports unchanged when the property is absent", () => {
    const result = removeProperty(simple, "LangVersion");
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.text, simple);
  });

  it("removes only the element when it shares its line", () => {
    const text = project("  <PropertyGroup><Nullable>enable</Nullable><LangVersion>latest</LangVersion></PropertyGroup>");
    const result = removeProperty(text, "Nullable");
    assert.match(result.text, /<PropertyGroup><LangVersion>latest<\/LangVersion><\/PropertyGroup>/);
  });

  it("preserves CRLF", () => {
    const crlf = simple.replace(/\n/g, "\r\n");
    const result = removeProperty(crlf, "Nullable");
    assert.ok(!/[^\r]\n/.test(result.text));
  });
});

describe("setTargetFrameworks", () => {
  it("switches from TargetFramework to TargetFrameworks", () => {
    const result = setTargetFrameworks(simple, ["net9.0", "net10.0"]);
    assert.equal(readDeclaration(result.text, "TargetFramework").state, "none");
    assert.deepEqual(parseTargetFrameworks(result.text), ["net9.0", "net10.0"]);
  });

  it("switches back to the singular tag", () => {
    const multi = project("  <PropertyGroup>\n    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>\n  </PropertyGroup>");
    const result = setTargetFrameworks(multi, ["net10.0"]);
    assert.equal(readDeclaration(result.text, "TargetFrameworks").state, "none");
    assert.deepEqual(parseTargetFrameworks(result.text), ["net10.0"]);
  });

  it("round-trips through the reader", () => {
    for (const frameworks of [["net10.0"], ["net8.0", "net9.0", "net10.0"]]) {
      const result = setTargetFrameworks(simple, frameworks);
      assert.deepEqual(parseTargetFrameworks(result.text), frameworks);
    }
  });

  it("adds the property when the project declares neither tag", () => {
    const bare = project("  <PropertyGroup>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>");
    const result = setTargetFrameworks(bare, ["net10.0"]);
    assert.equal(result.outcome, "inserted");
    assert.deepEqual(parseTargetFrameworks(result.text), ["net10.0"]);
  });

  it("refuses atomically when either tag is conditioned", () => {
    const text = project(`  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Multi)'=='true'">
    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>
  </PropertyGroup>`);
    const result = setTargetFrameworks(text, ["net9.0", "net10.0"]);
    assert.equal(result.outcome, "refusedConditioned");
    assert.equal(result.text, text, "neither edit may be applied");
  });

  it("refuses an empty framework list", () => {
    assert.equal(setTargetFrameworks(simple, []).outcome, "refusedInvalidValue");
    assert.equal(setTargetFrameworks(simple, ["  "]).outcome, "refusedInvalidValue");
  });
});

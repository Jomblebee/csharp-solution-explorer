import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeXmlText,
  readDeclaration,
  scanCsproj,
  unescapeXmlText,
} from "../../../src/solutionExplorer/parsers/csprojPropertyScanner.js";

const project = (body: string) => `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n`;

const simple = project(`  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);

describe("readDeclaration — declared", () => {
  it("finds a property in an unconditional PropertyGroup", () => {
    const declaration = readDeclaration(simple, "TargetFramework");
    assert.equal(declaration.state, "declared");
    assert.equal(declaration.state === "declared" && declaration.value, "net10.0");
    assert.equal(declaration.state === "declared" && declaration.line, 2);
  });

  it("matches case-insensitively", () => {
    assert.equal(readDeclaration(simple, "targetframework").state, "declared");
  });

  it("reports absence", () => {
    assert.equal(readDeclaration(simple, "LangVersion").state, "none");
  });

  it("does not confuse a property with a longer one that starts the same way", () => {
    // The trap: <TargetFrameworkVersion> must not answer a query for <TargetFramework>.
    const text = project("  <PropertyGroup>\n    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n  </PropertyGroup>");
    assert.equal(readDeclaration(text, "TargetFramework").state, "none");
    assert.equal(readDeclaration(text, "TargetFrameworkVersion").state, "declared");
  });

  it("finds a property in a single-line PropertyGroup", () => {
    // Missing this would be the dangerous failure: the writer would add a second declaration.
    const text = project("  <PropertyGroup><Nullable>enable</Nullable></PropertyGroup>");
    const declaration = readDeclaration(text, "Nullable");
    assert.equal(declaration.state, "declared");
    assert.equal(declaration.state === "declared" && declaration.value, "enable");
  });

  it("recognises a self-closing element", () => {
    const text = project("  <PropertyGroup>\n    <Nullable />\n  </PropertyGroup>");
    const declaration = readDeclaration(text, "Nullable");
    assert.equal(declaration.state, "declared");
    assert.equal(declaration.state === "declared" && declaration.value, "");
  });

  it("keeps the last of several unconditional declarations and lists them all", () => {
    const text = project(`  <PropertyGroup>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const declaration = readDeclaration(text, "Nullable");
    assert.equal(declaration.state === "declared" && declaration.value, "enable");
    assert.deepEqual(declaration.state === "declared" && declaration.duplicateLines, [2, 5]);
  });

  it("unescapes and trims the value", () => {
    const text = project("  <PropertyGroup>\n    <NoWarn>  A &amp; B  </NoWarn>\n  </PropertyGroup>");
    const declaration = readDeclaration(text, "NoWarn");
    assert.equal(declaration.state === "declared" && declaration.value, "A & B");
  });

  it("keeps an MSBuild expression verbatim", () => {
    const text = project("  <PropertyGroup>\n    <NoWarn>$(NoWarn);NU1903</NoWarn>\n  </PropertyGroup>");
    const declaration = readDeclaration(text, "NoWarn");
    assert.equal(declaration.state === "declared" && declaration.value, "$(NoWarn);NU1903");
  });
});

describe("readDeclaration — conditioned", () => {
  it("reports a Condition on the PropertyGroup, with its text verbatim", () => {
    const text = project(`  <PropertyGroup Condition="'$(Configuration)'=='Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>`);
    const declaration = readDeclaration(text, "TreatWarningsAsErrors");
    assert.equal(declaration.state, "conditioned");
    assert.deepEqual(declaration.state === "conditioned" && declaration.conditions, ["'$(Configuration)'=='Release'"]);
  });

  it("reports a Condition on the property element itself", () => {
    const text = project(`  <PropertyGroup>
    <Nullable Condition="'$(X)'=='1'">enable</Nullable>
  </PropertyGroup>`);
    assert.equal(readDeclaration(text, "Nullable").state, "conditioned");
  });

  it("treats a PropertyGroup inside a Target as conditioned", () => {
    const text = project(`  <Target Name="Prepare">
    <PropertyGroup>
      <Nullable>enable</Nullable>
    </PropertyGroup>
  </Target>`);
    assert.equal(readDeclaration(text, "Nullable").state, "conditioned");
  });

  it("treats a PropertyGroup inside Choose/When as conditioned", () => {
    const text = project(`  <Choose>
    <When Condition="'$(X)'=='1'">
      <PropertyGroup>
        <Nullable>enable</Nullable>
      </PropertyGroup>
    </When>
  </Choose>`);
    assert.equal(readDeclaration(text, "Nullable").state, "conditioned");
  });

  it("survives a condition containing an unescaped '>'", () => {
    const text = project(`  <PropertyGroup Condition="$(Version) > 5">
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    assert.equal(readDeclaration(text, "Nullable").state, "conditioned");
  });

  it("prefers an unconditional declaration over a conditioned one", () => {
    const text = project(`  <PropertyGroup Condition="'$(Configuration)'=='Release'">
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <PropertyGroup>
    <Nullable>enable</Nullable>
  </PropertyGroup>`);
    const declaration = readDeclaration(text, "Nullable");
    assert.equal(declaration.state === "declared" && declaration.value, "enable");
  });
});

describe("readDeclaration — unwritable", () => {
  it("ignores a commented-out declaration", () => {
    const text = project(`  <PropertyGroup>
    <!-- <Nullable>enable</Nullable> -->
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>`);
    assert.equal(readDeclaration(text, "Nullable").state, "none");
    assert.equal(readDeclaration(text, "TargetFramework").state, "declared");
  });

  it("reports a value spread over several lines", () => {
    const text = project(`  <PropertyGroup>
    <NoWarn>
      NU1903
    </NoWarn>
  </PropertyGroup>`);
    const declaration = readDeclaration(text, "NoWarn");
    assert.equal(declaration.state, "unwritable");
    assert.equal(declaration.state === "unwritable" && declaration.reason, "multiLine");
  });

  it("reports a CDATA value", () => {
    const text = project("  <PropertyGroup>\n    <Banner><![CDATA[a > b]]></Banner>\n  </PropertyGroup>");
    const declaration = readDeclaration(text, "Banner");
    assert.equal(declaration.state, "unwritable");
    assert.equal(declaration.state === "unwritable" && declaration.reason, "cdata");
  });

  it("reports a property that sits outside any PropertyGroup", () => {
    const declaration = readDeclaration(project("  <Nullable>enable</Nullable>"), "Nullable");
    assert.equal(declaration.state, "unwritable");
    assert.equal(declaration.state === "unwritable" && declaration.reason, "unexpectedLocation");
  });
});

describe("scanCsproj", () => {
  it("reports the PropertyGroup spans and the project close line", () => {
    const scan = scanCsproj(simple);
    assert.equal(scan.malformed, false);
    assert.equal(scan.groups.length, 1);
    assert.equal(scan.groups[0].openLine, 1);
    assert.equal(scan.groups[0].closeLine, 4);
    assert.equal(scan.groups[0].indent, "  ");
    assert.equal(scan.projectCloseLine, 5);
  });

  it("flags a missing </Project> as malformed", () => {
    assert.equal(scanCsproj("<Project>\n  <PropertyGroup>\n  </PropertyGroup>\n").malformed, true);
  });

  it("flags an unbalanced PropertyGroup as malformed", () => {
    assert.equal(scanCsproj(project("  <PropertyGroup>")).malformed, true);
    assert.equal(scanCsproj(project("  </PropertyGroup>")).malformed, true);
  });

  it("ignores a self-closing PropertyGroup", () => {
    const scan = scanCsproj(project("  <PropertyGroup />"));
    assert.equal(scan.malformed, false);
    assert.equal(scan.groups.length, 0);
  });

  it("keeps line indices and the detected newline right in a CRLF file", () => {
    const scan = scanCsproj(simple.replace(/\n/g, "\r\n"));
    assert.equal(scan.model.newline, "\r\n");
    assert.equal(scan.groups[0].openLine, 1);
    assert.equal(scan.groups[0].closeLine, 4);
  });
});

describe("escapeXmlText / unescapeXmlText", () => {
  it("escapes only the text-node entities", () => {
    assert.equal(escapeXmlText(`a & b < c > d "e"`), `a &amp; b &lt; c &gt; d "e"`);
  });

  it("leaves MSBuild expressions untouched", () => {
    assert.equal(escapeXmlText("$(NoWarn);NU1903"), "$(NoWarn);NU1903");
  });

  it("round-trips", () => {
    const value = `a & b < c > d`;
    assert.equal(unescapeXmlText(escapeXmlText(value)), value);
  });

  it("decodes numeric and named entities", () => {
    assert.equal(unescapeXmlText("&#65;&#x42;&quot;&apos;"), `AB"'`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLaunchSettingsEdit,
  EditableProfileFields,
  LaunchSettingsEdit,
} from "../src/solutionExplorer/launchSettingsWriter.js";
import { parseLaunchSettings } from "../src/solutionExplorer/launchSettingsReader.js";

/** A minimal, valid editable-fields object with the given overrides. */
function fields(overrides: Partial<EditableProfileFields> = {}): EditableProfileFields {
  return {
    commandName: "Project",
    launchBrowser: false,
    dotnetRunMessages: false,
    environmentVariables: {},
    ...overrides,
  };
}

/** Builds a single-profile edit from a name and its fields. */
function editOf(name: string, f: EditableProfileFields, extra: Partial<LaunchSettingsEdit> = {}): LaunchSettingsEdit {
  return { order: [name], profiles: { [name]: f }, ...extra };
}

const BOM = "\uFEFF";

type ParsedLaunchSettings = {
  profiles: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

/** Parses writer output, tolerating the UTF-8 BOM it prepends to freshly scaffolded files. */
function parseOut(text: string): ParsedLaunchSettings {
  return JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
}

describe("applyLaunchSettingsEdit", () => {
  it("preserves unknown top-level and per-profile keys when editing one field", () => {
    const original = JSON.stringify(
      {
        $schema: "http://json.schemastore.org/launchsettings.json",
        iisSettings: { windowsAuthentication: false, iisExpress: { applicationUrl: "http://localhost:1234" } },
        profiles: {
          http: {
            commandName: "Project",
            dotnetRunMessages: true,
            applicationUrl: "http://localhost:5000",
            nativeDebugging: true,
            use64BitIISExpress: false,
          },
        },
      },
      null,
      2,
    );

    const result = applyLaunchSettingsEdit(
      original,
      editOf("http", fields({ commandName: "Project", dotnetRunMessages: true, applicationUrl: "http://localhost:9999" })),
    );
    const data = JSON.parse(result);

    assert.equal(data.$schema, "http://json.schemastore.org/launchsettings.json");
    assert.deepEqual(data.iisSettings, {
      windowsAuthentication: false,
      iisExpress: { applicationUrl: "http://localhost:1234" },
    });
    assert.equal(data.profiles.http.nativeDebugging, true);
    assert.equal(data.profiles.http.use64BitIISExpress, false);
    assert.equal(data.profiles.http.applicationUrl, "http://localhost:9999");
  });

  it("leaves other profiles untouched", () => {
    const original = JSON.stringify({
      profiles: {
        a: { commandName: "Project", applicationUrl: "http://a" },
        b: { commandName: "Executable", executablePath: "dotnet", weirdKey: 42 },
      },
    });

    const result = applyLaunchSettingsEdit(original, {
      order: ["a", "b"],
      profiles: {
        a: fields({ applicationUrl: "http://changed" }),
        b: fields({ commandName: "Executable", executablePath: "dotnet" }),
      },
    });
    const data = JSON.parse(result);

    assert.equal(data.profiles.a.applicationUrl, "http://changed");
    assert.equal(data.profiles.b.weirdKey, 42);
    assert.equal(data.profiles.b.executablePath, "dotnet");
  });

  it("deletes optional string keys when cleared to empty", () => {
    const original = JSON.stringify({
      profiles: { http: { commandName: "Project", applicationUrl: "http://localhost:5000", launchUrl: "swagger" } },
    });

    const result = applyLaunchSettingsEdit(
      original,
      editOf("http", fields({ applicationUrl: "", launchUrl: undefined })),
    );
    const http = JSON.parse(result).profiles.http;

    assert.equal("applicationUrl" in http, false);
    assert.equal("launchUrl" in http, false);
  });

  it("writes launchBrowser only when true", () => {
    const on = parseOut(applyLaunchSettingsEdit("", editOf("p", fields({ launchBrowser: true })))).profiles.p;
    const off = parseOut(applyLaunchSettingsEdit("", editOf("p", fields({ launchBrowser: false })))).profiles.p;

    assert.equal(on.launchBrowser, true);
    assert.equal("launchBrowser" in off, false);
  });

  it("preserves an explicit dotnetRunMessages, otherwise omits it when false", () => {
    const explicit = JSON.stringify({ profiles: { p: { commandName: "Project", dotnetRunMessages: false } } });
    const kept = JSON.parse(
      applyLaunchSettingsEdit(explicit, editOf("p", fields({ dotnetRunMessages: false }))),
    ).profiles.p;
    assert.equal(kept.dotnetRunMessages, false);

    const fresh = parseOut(applyLaunchSettingsEdit("", editOf("p", fields({ dotnetRunMessages: false })))).profiles.p;
    assert.equal("dotnetRunMessages" in fresh, false);
  });

  it("adds environmentVariables and drops the key when empty", () => {
    const withEnv = parseOut(
      applyLaunchSettingsEdit("", editOf("p", fields({ environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" } }))),
    ).profiles.p;
    assert.deepEqual(withEnv.environmentVariables, { ASPNETCORE_ENVIRONMENT: "Development" });

    const original = JSON.stringify({ profiles: { p: { commandName: "Project", environmentVariables: { X: "1" } } } });
    const cleared = JSON.parse(applyLaunchSettingsEdit(original, editOf("p", fields()))).profiles.p;
    assert.equal("environmentVariables" in cleared, false);
  });

  it("adds a new profile appended in order", () => {
    const original = JSON.stringify({ profiles: { a: { commandName: "Project" } } });
    const result = applyLaunchSettingsEdit(original, {
      order: ["a", "b"],
      profiles: { a: fields(), b: fields({ applicationUrl: "http://b" }) },
    });

    assert.deepEqual(Object.keys(JSON.parse(result).profiles), ["a", "b"]);
    assert.equal(JSON.parse(result).profiles.b.applicationUrl, "http://b");
  });

  it("renames a profile while keeping its unknown keys and order", () => {
    const original = JSON.stringify({
      profiles: {
        first: { commandName: "Project", applicationUrl: "http://a", nativeDebugging: true },
        second: { commandName: "Project" },
      },
    });

    const result = applyLaunchSettingsEdit(original, {
      order: ["renamed", "second"],
      profiles: { renamed: fields({ applicationUrl: "http://a" }), second: fields() },
      renames: { renamed: "first" },
    });
    const data = JSON.parse(result);

    assert.deepEqual(Object.keys(data.profiles), ["renamed", "second"]);
    assert.equal(data.profiles.renamed.nativeDebugging, true);
    assert.equal("first" in data.profiles, false);
  });

  it("deletes a profile by omitting it from the edit", () => {
    const original = JSON.stringify({
      profiles: { keep: { commandName: "Project" }, drop: { commandName: "Project" } },
    });

    const result = applyLaunchSettingsEdit(original, editOf("keep", fields()));

    assert.deepEqual(Object.keys(JSON.parse(result).profiles), ["keep"]);
  });

  it("scaffolds a new file with schema, BOM, 2-space indent and trailing newline", () => {
    const result = applyLaunchSettingsEdit("", editOf("http", fields({ applicationUrl: "http://localhost:5000" })));

    assert.ok(result.startsWith(BOM), "expected a UTF-8 BOM");
    const body = result.slice(BOM.length);
    assert.ok(body.endsWith("\n"), "expected a trailing newline");
    assert.match(body, /\n  "profiles": \{/, "expected 2-space indentation");

    const data = JSON.parse(body);
    assert.equal(data.$schema, "http://json.schemastore.org/launchsettings.json");
    assert.equal(data.profiles.http.applicationUrl, "http://localhost:5000");
  });

  it("retains a BOM present in the original and none when absent", () => {
    const withBom = applyLaunchSettingsEdit(BOM + JSON.stringify({ profiles: { p: { commandName: "Project" } } }), editOf("p", fields()));
    const without = applyLaunchSettingsEdit(JSON.stringify({ profiles: { p: { commandName: "Project" } } }), editOf("p", fields()));

    assert.ok(withBom.startsWith(BOM));
    assert.equal(without.startsWith(BOM), false);
  });

  it("round-trips through the reader to the intended model", () => {
    const result = applyLaunchSettingsEdit(
      "",
      editOf(
        "https",
        fields({
          commandName: "Project",
          commandLineArgs: "--urls https://localhost:7000",
          applicationUrl: "https://localhost:7000",
          launchBrowser: true,
          dotnetRunMessages: true,
          environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" },
        }),
      ),
    );

    const parsed = parseLaunchSettings(result);
    assert.equal(parsed.profiles.length, 1);
    const profile = parsed.profiles[0];
    assert.equal(profile.name, "https");
    assert.equal(profile.commandName, "Project");
    assert.equal(profile.applicationUrl, "https://localhost:7000");
    assert.equal(profile.launchBrowser, true);
    assert.deepEqual(profile.environmentVariables, { ASPNETCORE_ENVIRONMENT: "Development" });
  });
});

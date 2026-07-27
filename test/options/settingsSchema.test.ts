import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSettingsSchema, type SettingDescriptor } from "../../src/options/settingsSchema.js";

const group = (title: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title,
  id: `csharpSolutionExplorer.${title.toLowerCase()}`,
  properties,
  ...extra,
});

const build = (configuration: unknown) => buildSettingsSchema({ configuration });

const find = (configuration: unknown, key: string): SettingDescriptor | undefined =>
  build(configuration)
    .flatMap((entry) => entry.settings)
    .find((setting) => setting.key === key);

describe("buildSettingsSchema — manifest forms", () => {
  it("accepts the array form", () => {
    const groups = build([group("Debug", { "csharpSolutionExplorer.debug.enabled": { type: "boolean", default: true } })]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].settings.length, 1);
  });

  it("accepts the single-object form", () => {
    const groups = build(group("Debug", { "csharpSolutionExplorer.debug.enabled": { type: "boolean", default: true } }));
    assert.equal(groups.length, 1);
  });

  it("returns an empty list when configuration is missing", () => {
    assert.deepEqual(buildSettingsSchema({}), []);
    assert.deepEqual(buildSettingsSchema(undefined), []);
    assert.deepEqual(buildSettingsSchema("nonsense"), []);
  });
});

describe("buildSettingsSchema — ordering", () => {
  it("sorts groups by order", () => {
    const groups = build([
      group("Debug", { "csharpSolutionExplorer.b": { type: "boolean" } }, { order: 3 }),
      group("Templates", { "csharpSolutionExplorer.c": { type: "boolean" } }, { order: 1 }),
    ]);
    assert.deepEqual(
      groups.map((entry) => entry.title),
      ["Templates", "Debug"],
    );
  });

  it("keeps a group without an order at its manifest position", () => {
    // The general group is conventionally declared first and unnumbered; sorting it last would put
    // the panel's most-used settings at the bottom.
    const groups = build([
      group("General", { "csharpSolutionExplorer.a": { type: "boolean" } }),
      group("Templates", { "csharpSolutionExplorer.c": { type: "boolean" } }, { order: 1 }),
      group("Debug", { "csharpSolutionExplorer.b": { type: "boolean" } }, { order: 3 }),
    ]);
    assert.deepEqual(
      groups.map((entry) => entry.title),
      ["General", "Templates", "Debug"],
    );
  });

  it("preserves the authored property order inside a group", () => {
    const groups = build([
      group("Debug", {
        "csharpSolutionExplorer.debug.zulu": { type: "boolean" },
        "csharpSolutionExplorer.debug.alpha": { type: "boolean" },
      }),
    ]);
    assert.deepEqual(
      groups[0].settings.map((setting) => setting.key),
      ["csharpSolutionExplorer.debug.zulu", "csharpSolutionExplorer.debug.alpha"],
    );
  });
});

describe("buildSettingsSchema — editor mapping", () => {
  const editorOf = (key: string, schema: Record<string, unknown>) =>
    find([group("Group", { [key]: schema })], key)?.editor;

  it("maps boolean, number and integer", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "boolean" }), "boolean");
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "number" }), "number");
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "integer" }), "number");
  });

  it("maps a string enum to a dropdown", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "string", enum: ["x", "y"] }), "enum");
  });

  it("maps a single-line string default to a text field", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "string", default: "Information" }), "string");
  });

  it("maps a multi-line string default to a textarea", () => {
    // The template settings are source snippets: a one-line input would be unusable.
    const schema = { type: "string", default: "namespace ${namespace};\n\npublic class ${name}\n{\n}\n" };
    assert.equal(editorOf("csharpSolutionExplorer.templates.class", schema), "multilineString");
  });

  it("maps array and object", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "array" }), "stringArray");
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "object" }), "objectJson");
  });

  it("falls back to unsupported for a missing or union type", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { default: 1 }), "unsupported");
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: ["string", "null"] }), "unsupported");
  });

  it("ignores a non-string enum rather than rendering a dropdown it cannot write", () => {
    assert.equal(editorOf("csharpSolutionExplorer.a", { type: "number", enum: [1, 2] }), "number");
  });
});

describe("buildSettingsSchema — descriptor fields", () => {
  it("carries enum values, index-aligned descriptions, minimum and maximum", () => {
    const key = "csharpSolutionExplorer.debug.f5Console";
    const descriptor = find(
      [
        group("Debug", {
          [key]: {
            type: "string",
            enum: ["internalConsole", "externalTerminal"],
            enumDescriptions: ["In the Debug Console", "In a separate window"],
            default: "externalTerminal",
          },
          "csharpSolutionExplorer.debug.delayMs": { type: "number", minimum: 0, maximum: 5000, default: 0 },
        }),
      ],
      key,
    );
    assert.deepEqual(descriptor?.enumValues, ["internalConsole", "externalTerminal"]);
    assert.deepEqual(descriptor?.enumDescriptions, ["In the Debug Console", "In a separate window"]);
    assert.equal(descriptor?.default, "externalTerminal");

    const delay = find(
      [group("Debug", { "csharpSolutionExplorer.debug.delayMs": { type: "number", minimum: 0, maximum: 5000 } })],
      "csharpSolutionExplorer.debug.delayMs",
    );
    assert.equal(delay?.minimum, 0);
    assert.equal(delay?.maximum, 5000);
  });

  it("prefers markdownDescription and flags it", () => {
    const key = "csharpSolutionExplorer.a";
    const descriptor = find(
      [group("Group", { [key]: { type: "boolean", description: "plain", markdownDescription: "`code`" } })],
      key,
    );
    assert.equal(descriptor?.description, "`code`");
    assert.equal(descriptor?.markdown, true);
  });

  it("defaults the scope to window and marks machine scope user-only", () => {
    const windowed = find([group("Group", { "csharpSolutionExplorer.a": { type: "boolean" } })], "csharpSolutionExplorer.a");
    assert.equal(windowed?.configScope, "window");
    assert.equal(windowed?.userOnly, false);

    const machine = find(
      [group("Group", { "csharpSolutionExplorer.b": { type: "boolean", scope: "machine" } })],
      "csharpSolutionExplorer.b",
    );
    assert.equal(machine?.userOnly, true);
  });

  it("flags path-valued string settings for a Browse button", () => {
    const path = find(
      [group("Group", { "csharpSolutionExplorer.languageServer.serverPath": { type: "string", default: "" } })],
      "csharpSolutionExplorer.languageServer.serverPath",
    );
    assert.equal(path?.pathHint, true);

    const notPath = find(
      [group("Group", { "csharpSolutionExplorer.languageServer.version": { type: "string", default: "" } })],
      "csharpSolutionExplorer.languageServer.version",
    );
    assert.equal(notPath?.pathHint, false);
  });
});

describe("buildSettingsSchema — resilience", () => {
  it("drops malformed entries without throwing", () => {
    const groups = build([
      "not a group",
      { properties: { "csharpSolutionExplorer.a": { type: "boolean" } } }, // no title
      group("Group", { "csharpSolutionExplorer.a": "not a schema", "csharpSolutionExplorer.b": { type: "boolean" } }),
      group("Empty", {}),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].settings.map((setting) => setting.key),
      ["csharpSolutionExplorer.b"],
    );
  });
});

describe("buildSettingsSchema — labels", () => {
  const labelOf = (key: string, groupId = "csharpSolutionExplorer.debug") =>
    find([{ title: "Debug", id: groupId, properties: { [key]: { type: "boolean" } } }], key)?.label;

  it("strips the group prefix and splits camelCase", () => {
    assert.equal(labelOf("csharpSolutionExplorer.debug.buildBeforeLaunch"), "Build before launch");
  });

  it("falls back to the extension prefix when the key sits outside its group's namespace", () => {
    // testExplorer.* lives in the Debugger group in this extension's manifest.
    assert.equal(labelOf("csharpSolutionExplorer.testExplorer.outputVerbosity"), "Test explorer output verbosity");
  });

  it("applies word overrides", () => {
    assert.equal(labelOf("csharpSolutionExplorer.debug.serverUrl"), "Server URL");
  });

  it("applies key overrides", () => {
    assert.equal(labelOf("csharpSolutionExplorer.debug.f5Console"), "F5 console");
    assert.equal(labelOf("csharpSolutionExplorer.nuget.checkForUpdates"), "Check for NuGet updates");
  });
});

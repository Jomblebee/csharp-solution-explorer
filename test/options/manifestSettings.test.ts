// Drift guard: the Options panel generates itself from package.json, so a setting the generator
// cannot render degrades the panel silently. This runs the real manifest through it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { buildSettingsSchema } from "../../src/options/settingsSchema.js";

// `npm test` runs from the repo root, which is where the manifest under test lives.
const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes?: { configuration?: unknown };
};
const groups = buildSettingsSchema(manifest.contributes);
const settings = groups.flatMap((group) => group.settings);

describe("the real manifest", () => {
  it("produces a group per contributed configuration section", () => {
    const raw = manifest.contributes?.configuration;
    assert.equal(groups.length, Array.isArray(raw) ? raw.length : 1);
  });

  it("covers every contributed key", () => {
    const declared = (manifest.contributes?.configuration as { properties?: Record<string, unknown> }[])
      .flatMap((group) => Object.keys(group.properties ?? {}))
      .sort();
    assert.deepEqual(settings.map((setting) => setting.key).sort(), declared);
  });

  it("renders every setting with a real editor", () => {
    const unsupported = settings.filter((setting) => setting.editor === "unsupported").map((setting) => setting.key);
    assert.deepEqual(unsupported, [], "add an editor for these in settingsSchema.ts");
  });

  it("gives every setting a label rather than falling back to the key", () => {
    const bad = settings.filter(
      (setting) => setting.label === setting.key || setting.label.includes("csharpSolutionExplorer"),
    );
    assert.deepEqual(
      bad.map((setting) => setting.key),
      [],
      "add a LABEL_OVERRIDES entry for these",
    );
  });

  it("describes every setting", () => {
    const undocumented = settings.filter((setting) => !setting.description).map((setting) => setting.key);
    assert.deepEqual(undocumented, []);
  });

  it("gives every enum setting one enumDescriptions entry per value", () => {
    // The panel's dropdown shows a description under every value, so a missing entry is a blank row
    // rather than a cosmetic loss.
    for (const setting of settings.filter((entry) => entry.editor === "enum")) {
      assert.equal(
        setting.enumDescriptions?.length,
        setting.enumValues?.length,
        `${setting.key}: enumDescriptions must exist and align with enum`,
      );
    }
  });
});

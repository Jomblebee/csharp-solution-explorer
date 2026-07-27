import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSettingValue } from "../../src/options/settingValidation.js";
import type { EditorKind, SettingDescriptor } from "../../src/options/settingsSchema.js";

const descriptor = (editor: EditorKind, extra: Partial<SettingDescriptor> = {}): SettingDescriptor => ({
  key: "csharpSolutionExplorer.test",
  label: "Test",
  editor,
  markdown: false,
  default: undefined,
  configScope: "window",
  userOnly: false,
  pathHint: false,
  ...extra,
});

describe("validateSettingValue", () => {
  it("accepts a boolean and rejects anything else", () => {
    assert.deepEqual(validateSettingValue(descriptor("boolean"), false), { ok: true, value: false });
    assert.equal(validateSettingValue(descriptor("boolean"), "true").ok, false);
  });

  it("accepts only declared enum members", () => {
    const setting = descriptor("enum", { enumValues: ["auto", "never"] });
    assert.equal(validateSettingValue(setting, "auto").ok, true);
    assert.equal(validateSettingValue(setting, "sometimes").ok, false);
  });

  it("enforces minimum and maximum", () => {
    const setting = descriptor("number", { minimum: 0, maximum: 100 });
    assert.equal(validateSettingValue(setting, 50).ok, true);
    assert.equal(validateSettingValue(setting, -1).ok, false);
    assert.equal(validateSettingValue(setting, 101).ok, false);
  });

  it("rejects NaN and non-numbers", () => {
    assert.equal(validateSettingValue(descriptor("number"), Number.NaN).ok, false);
    assert.equal(validateSettingValue(descriptor("number"), "5").ok, false);
  });

  it("accepts text for both string editors", () => {
    assert.equal(validateSettingValue(descriptor("string"), "").ok, true);
    assert.equal(validateSettingValue(descriptor("multilineString"), "a\nb").ok, true);
    assert.equal(validateSettingValue(descriptor("string"), 1).ok, false);
  });

  it("accepts a list of strings only", () => {
    assert.equal(validateSettingValue(descriptor("stringArray"), ["a", "b"]).ok, true);
    assert.equal(validateSettingValue(descriptor("stringArray"), ["a", 2]).ok, false);
    assert.equal(validateSettingValue(descriptor("stringArray"), "a").ok, false);
  });

  it("accepts an object but not an array or null", () => {
    assert.equal(validateSettingValue(descriptor("objectJson"), { a: 1 }).ok, true);
    assert.equal(validateSettingValue(descriptor("objectJson"), [1]).ok, false);
    assert.equal(validateSettingValue(descriptor("objectJson"), null).ok, false);
  });

  it("refuses to write a setting it cannot render", () => {
    const result = validateSettingValue(descriptor("unsupported"), "anything");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : "", /settings\.json/);
  });
});

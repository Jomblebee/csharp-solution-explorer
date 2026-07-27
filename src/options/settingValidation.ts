// Re-checks a value the webview posted against the setting's own descriptor before it reaches
// `config.update`.
//
// The webview already validates while typing, but a webview is a rendering surface, not a trust
// boundary: it can be showing a schema from before a reload, and a wrong-typed value written to
// settings.json is a broken setting the user then has to find by hand. The check is cheap and the
// panel is the only thing writing these keys, so it happens here.
//
// Pure — no vscode.

import type { SettingDescriptor } from "./settingsSchema.js";

export type ValidationResult = { ok: true; value: unknown } | { ok: false; message: string };

/** Coerces and validates `value` for `descriptor`, or explains why it cannot be written. */
export function validateSettingValue(descriptor: SettingDescriptor, value: unknown): ValidationResult {
  switch (descriptor.editor) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : fail(descriptor, "a true/false value");

    case "enum": {
      if (typeof value !== "string") {
        return fail(descriptor, "one of the listed values");
      }
      return descriptor.enumValues?.includes(value)
        ? { ok: true, value }
        : { ok: false, message: `"${value}" is not a valid value for ${descriptor.key}.` };
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail(descriptor, "a number");
      }
      if (descriptor.minimum !== undefined && value < descriptor.minimum) {
        return { ok: false, message: `${descriptor.key} must be at least ${descriptor.minimum}.` };
      }
      if (descriptor.maximum !== undefined && value > descriptor.maximum) {
        return { ok: false, message: `${descriptor.key} must be at most ${descriptor.maximum}.` };
      }
      return { ok: true, value };
    }

    case "string":
    case "multilineString":
      return typeof value === "string" ? { ok: true, value } : fail(descriptor, "text");

    case "stringArray":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? { ok: true, value }
        : fail(descriptor, "a list of strings");

    case "objectJson":
      // The webview sends the parsed object, not the text it validated — an array or a primitive
      // here means it parsed something that is valid JSON but the wrong shape.
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ok: true, value }
        : fail(descriptor, "a JSON object");

    case "unsupported":
      return { ok: false, message: `${descriptor.key} can only be edited in settings.json.` };
  }
}

function fail(descriptor: SettingDescriptor, expected: string): ValidationResult {
  return { ok: false, message: `${descriptor.key} expects ${expected}.` };
}

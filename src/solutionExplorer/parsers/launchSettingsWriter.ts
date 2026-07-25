/**
 * Writes a project's `Properties/launchSettings.json` back to disk, VS-compatibly. Like
 * `launchSettingsReader.ts` this is pure (no vscode, no MSBuild) so it stays unit-testable; the
 * fs read/write lives in `launchProfileCommands.ts`.
 *
 * The one rule that matters: this never re-serializes from the `LaunchProfile` model, because that
 * would silently drop everything the reader does not model — the top-level `$schema`/`iisSettings`
 * and per-profile keys like `nativeDebugging`, `hotReloadEnabled`, `sqlDebugging`,
 * `use64BitIISExpress`, `inspectUri`, … Instead it *round-trips*: it parses the existing file into a
 * generic object, then mutates only the fields the editor owns, so unknown keys survive untouched.
 *
 * Write rules chosen for parity with what Visual Studio / `dotnet new` emit:
 *  - optional string fields are written when non-empty and the key is *deleted* when cleared;
 *  - `environmentVariables` is written as an object, and the key is dropped when empty;
 *  - `launchBrowser` is written only when `true` (VS omits it when false);
 *  - `dotnetRunMessages` is preserved with its value when the original profile had the key, and
 *    otherwise omitted — never injected, so rewriting an untouched profile does not add keys (its
 *    default is `true` anyway);
 *  - output is two-space indented with a trailing newline, and carries a UTF-8 BOM when the original
 *    did (or when scaffolding a new file — `dotnet new` writes one).
 */

const SCHEMA_URL = "http://json.schemastore.org/launchsettings.json";
const BOM = "\uFEFF";

/** The subset of profile fields the editor owns and writes; mirrors `LaunchProfile` minus `name`. */
export interface EditableProfileFields {
  commandName: string;
  executablePath?: string;
  commandLineArgs?: string;
  workingDirectory?: string;
  applicationUrl?: string;
  launchUrl?: string;
  launchBrowser: boolean;
  dotnetRunMessages: boolean;
  environmentVariables: Record<string, string>;
}

export interface LaunchSettingsEdit {
  /** Final profile names, in the order they should appear. */
  order: string[];
  /** Editable fields per final profile name. */
  profiles: Record<string, EditableProfileFields>;
  /** Final name -> original name, so a renamed profile keeps its unknown raw keys. */
  renames?: Record<string, string>;
}

function stripBom(text: string): { text: string; hadBom: boolean } {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), hadBom: true } : { text, hadBom: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `{ "$schema": ..., "profiles": {} }` scaffold for a project that has no launch settings yet. */
export function emptyLaunchSettings(): Record<string, unknown> {
  return { $schema: SCHEMA_URL, profiles: {} };
}

/**
 * Applies `edit` to the raw JSON of `originalText` (which may be empty or malformed — then a fresh
 * scaffold is used) and returns the serialized, VS-compatible file text.
 */
export function applyLaunchSettingsEdit(originalText: string, edit: LaunchSettingsEdit): string {
  const { text, hadBom } = stripBom(originalText);
  const trimmed = text.trim();

  let data: Record<string, unknown>;
  let parsed: unknown;
  try {
    parsed = trimmed.length > 0 ? JSON.parse(trimmed) : undefined;
  } catch {
    parsed = undefined;
  }
  const isNewFile = !isPlainObject(parsed);
  data = isNewFile ? emptyLaunchSettings() : { ...(parsed as Record<string, unknown>) };

  const oldProfiles = isPlainObject(data.profiles) ? data.profiles : {};
  const renames = edit.renames ?? {};

  const newProfiles: Record<string, unknown> = {};
  for (const name of edit.order) {
    const fields = edit.profiles[name];
    if (!fields) {
      continue;
    }
    const sourceName = renames[name] ?? name;
    const base = isPlainObject(oldProfiles[sourceName]) ? { ...(oldProfiles[sourceName] as Record<string, unknown>) } : {};
    newProfiles[name] = applyFields(base, fields);
  }

  data.profiles = newProfiles;

  const json = JSON.stringify(data, null, 2) + "\n";
  return hadBom || isNewFile ? BOM + json : json;
}

/** Overwrites only the editor-owned keys on a raw profile object, per the write rules above. */
function applyFields(base: Record<string, unknown>, fields: EditableProfileFields): Record<string, unknown> {
  const hadDotnetRunMessages = "dotnetRunMessages" in base;

  base.commandName = fields.commandName;
  setOrDelete(base, "executablePath", fields.executablePath);
  setOrDelete(base, "commandLineArgs", fields.commandLineArgs);
  setOrDelete(base, "workingDirectory", fields.workingDirectory);
  setOrDelete(base, "applicationUrl", fields.applicationUrl);
  setOrDelete(base, "launchUrl", fields.launchUrl);

  if (fields.launchBrowser) {
    base.launchBrowser = true;
  } else {
    delete base.launchBrowser;
  }

  // Preserve an author's explicit value; never inject the key where it was absent (default is true).
  if (hadDotnetRunMessages) {
    base.dotnetRunMessages = fields.dotnetRunMessages;
  } else {
    delete base.dotnetRunMessages;
  }

  if (Object.keys(fields.environmentVariables).length > 0) {
    base.environmentVariables = { ...fields.environmentVariables };
  } else {
    delete base.environmentVariables;
  }

  return base;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  } else {
    delete target[key];
  }
}

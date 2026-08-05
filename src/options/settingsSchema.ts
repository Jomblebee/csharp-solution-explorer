// Turns the extension's own `contributes.configuration` block into descriptors the Options panel
// renders. Reading the manifest rather than hand-listing the settings means a new key in package.json
// shows up in the panel with no second place to maintain — the price is that the shape arrives as
// `unknown` (the manifest is data, not a typed API), so every field is narrowed here.
//
// Nothing in this module throws. A malformed contribution costs that one setting, never the panel:
// a manifest typo must not leave the user staring at an empty page with no way to reach their
// settings.
//
// Pure — no vscode — so it stays unit-testable.

/** How the webview renders a setting's editor. */
export type EditorKind =
  | "boolean"
  | "enum"
  | "string"
  | "multilineString"
  | "number"
  | "stringArray"
  | "objectJson"
  | "unsupported";

export interface SettingDescriptor {
  /** The full configuration key, e.g. `csharpSolutionExplorer.debug.f5Console`. */
  key: string;
  label: string;
  editor: EditorKind;
  description?: string;
  /** Rendered as markdown when the manifest used `markdownDescription`. */
  markdown: boolean;
  enumValues?: string[];
  /** Index-aligned with `enumValues`; a shorter array leaves the tail without hints. */
  enumDescriptions?: string[];
  default: unknown;
  minimum?: number;
  maximum?: number;
  /** `scope` from the manifest, defaulting to VS Code's own default of `window`. */
  configScope: string;
  /** machine/application-scoped settings cannot be written per workspace. */
  userOnly: boolean;
  /** A path-valued string setting — the webview offers a Browse… button. */
  pathHint: boolean;
}

export interface SettingGroupDescriptor {
  id: string;
  title: string;
  order: number;
  settings: SettingDescriptor[];
}

/** Scopes VS Code resolves per workspace-folder rather than per window. */
const USER_ONLY_SCOPES = new Set(["machine", "machine-overridable", "application"]);

/**
 * Keys whose derived label reads badly. Kept deliberately small — the derivation below handles the
 * other two dozen, and every entry here is one more thing to remember when adding a setting.
 */
const LABEL_OVERRIDES: Record<string, string> = {
  "csharpSolutionExplorer.nuget.checkForUpdates": "Check for NuGet updates",
  "csharpSolutionExplorer.languageServer.razor.enabled": "Razor support",
  "csharpSolutionExplorer.debug.handleF5": "Handle F5",
  "csharpSolutionExplorer.debug.f5Console": "F5 console",
  "csharpSolutionExplorer.debug.ignoreLaunchJson": "Ignore launch.json",
  "csharpSolutionExplorer.debug.externalTerminalAttachDelayMs": "External terminal attach delay (ms)",
  "csharpSolutionExplorer.build.reuseMsBuildNodes": "Reuse MSBuild worker nodes",
  "csharpSolutionExplorer.build.maxCpuCount": "Maximum parallel projects",
};

/** Words the camelCase split would otherwise title-case into something wrong. */
const WORD_OVERRIDES: Record<string, string> = {
  nuget: "NuGet",
  url: "URL",
  urls: "URLs",
  id: "ID",
  json: "JSON",
  sdk: "SDK",
  trx: "TRX",
};

const PATH_KEY_PATTERN = /path$/i;

/**
 * Builds the panel's view of `contributes.configuration`. Accepts both manifest forms — the array of
 * groups this extension uses and the single-object form — because which one a manifest uses is an
 * authoring choice VS Code leaves open.
 */
export function buildSettingsSchema(contributes: unknown): SettingGroupDescriptor[] {
  const configuration = readProperty(contributes, "configuration");
  const rawGroups = Array.isArray(configuration) ? configuration : configuration === undefined ? [] : [configuration];

  const groups: SettingGroupDescriptor[] = [];
  rawGroups.forEach((raw, index) => {
    // `order` is optional. A group without one keeps its position in the manifest rather than being
    // pushed to the end: the general group is conventionally declared first and unnumbered, and it
    // belongs at the top of the panel too.
    const group = toGroup(raw, index);
    if (group && group.settings.length > 0) {
      groups.push(group);
    }
  });

  return groups.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

function toGroup(raw: unknown, index: number): SettingGroupDescriptor | undefined {
  const properties = readProperty(raw, "properties");
  if (!isRecord(properties)) {
    return undefined;
  }
  const title = readString(raw, "title");
  const id = readString(raw, "id") ?? title ?? "";
  if (!title) {
    return undefined;
  }

  const settings: SettingDescriptor[] = [];
  // Object key order is the authoring order, which groups related settings together far better than
  // sorting would.
  for (const [key, value] of Object.entries(properties)) {
    const descriptor = toDescriptor(key, value, id);
    if (descriptor) {
      settings.push(descriptor);
    }
  }

  return { id, title, order: readNumber(raw, "order") ?? index, settings };
}

function toDescriptor(key: string, raw: unknown, groupId: string): SettingDescriptor | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const type = readString(raw, "type");
  const enumValues = readStringArray(raw, "enum");
  const defaultValue = raw.default;
  const configScope = readString(raw, "scope") ?? "window";
  const markdownDescription = readString(raw, "markdownDescription");

  return {
    key,
    label: LABEL_OVERRIDES[key] ?? deriveLabel(key, groupId),
    editor: toEditorKind(type, enumValues, defaultValue),
    description: markdownDescription ?? readString(raw, "description"),
    markdown: markdownDescription !== undefined,
    enumValues,
    enumDescriptions: readStringArray(raw, "enumDescriptions") ?? readStringArray(raw, "markdownEnumDescriptions"),
    default: defaultValue,
    minimum: readNumber(raw, "minimum"),
    maximum: readNumber(raw, "maximum"),
    configScope,
    userOnly: USER_ONLY_SCOPES.has(configScope),
    pathHint: type === "string" && enumValues === undefined && PATH_KEY_PATTERN.test(key),
  };
}

function toEditorKind(type: string | undefined, enumValues: string[] | undefined, defaultValue: unknown): EditorKind {
  if (enumValues && enumValues.length > 0) {
    return "enum";
  }
  switch (type) {
    case "boolean":
      return "boolean";
    case "number":
    case "integer":
      return "number";
    case "string":
      // The template settings are multi-line source snippets stored as plain strings; a one-line
      // input would be unusable for them. The default value is the only signal the manifest gives.
      return typeof defaultValue === "string" && defaultValue.includes("\n") ? "multilineString" : "string";
    case "array":
      return "stringArray";
    case "object":
      return "objectJson";
    default:
      // Union types (`["string", "null"]`), `null`, or a missing `type`: render read-only and point
      // at settings.json rather than guessing an editor that could write the wrong shape.
      return "unsupported";
  }
}

/**
 * Derives a human label from the key: drop the group's own prefix, split camelCase, title-case.
 * `csharpSolutionExplorer.debug.buildBeforeLaunch` → `Build before launch`.
 */
function deriveLabel(key: string, groupId: string): string {
  let rest = key;
  for (const prefix of [`${groupId}.`, "csharpSolutionExplorer."]) {
    if (prefix.length > 1 && rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }

  const words = rest
    .split(".")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return key;
  }

  return words
    .map((word, index) => {
      const override = WORD_OVERRIDES[word.toLowerCase()];
      if (override) {
        return override;
      }
      // Sentence case, not title case: only the first word is capitalised, matching how VS Code
      // renders setting labels.
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProperty(source: unknown, name: string): unknown {
  return isRecord(source) ? source[name] : undefined;
}

function readString(source: unknown, name: string): string | undefined {
  const value = readProperty(source, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(source: unknown, name: string): number | undefined {
  const value = readProperty(source, name);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(source: unknown, name: string): string[] | undefined {
  const value = readProperty(source, name);
  if (!Array.isArray(value)) {
    return undefined;
  }
  // A mixed-type enum (numbers, null) has no string editor; treat it as absent so the setting falls
  // back to `unsupported` rather than rendering a dropdown that cannot write the real values.
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

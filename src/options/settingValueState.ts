// Reduces what `WorkspaceConfiguration.inspect()` reports into the per-setting state the panel needs:
// which value the active scope holds, whether that scope has an explicit entry, and — in the User
// tab — whether the workspace is quietly winning.
//
// Takes the plain object `inspect()` returns rather than importing vscode, so it stays unit-testable.

export type SettingScope = "user" | "workspace";

/** The subset of `vscode.WorkspaceConfiguration.inspect()` this module reads. */
export interface InspectResult {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
}

export interface SettingValueState {
  /** What the setting resolves to for the active scope — what the editor field shows. */
  effective: unknown;
  /** The active scope's own entry, `undefined` when it has none. */
  scopeValue?: unknown;
  /**
   * Whether the active scope holds an explicit entry. Presence, not inequality: writing a value
   * that happens to equal the default still creates a key, and VS Code marks that as modified — so
   * "Reset" stays meaningful and the dot matches what settings.json actually contains.
   */
  modified: boolean;
  /** User scope only: a workspace entry exists and overrides what this tab shows. */
  overriddenByWorkspace?: boolean;
  default: unknown;
}

/**
 * Whether writing `value` would only restate what the setting already inherits, so the write should
 * remove the entry instead of storing it. Picking the default back by hand otherwise leaves the
 * modified dot and an enabled Reset on a setting that is, to the user, no longer changed.
 *
 * A workspace write over an existing user entry is never collapsed: dropping it would hand the
 * setting back to the user value, which is not what the user just picked.
 */
export function restoresInherited(inspect: InspectResult | undefined, scope: SettingScope, value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (scope === "workspace" && inspect?.globalValue !== undefined) {
    return false;
  }
  return isSameValue(value, inspect?.defaultValue);
}

/** Structural equality for the JSON-shaped values settings hold. */
function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, i) => isSameValue(entry, b[i]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every((key) => key in right && isSameValue(left[key], right[key]))
  );
}

export function toValueState(inspect: InspectResult | undefined, scope: SettingScope): SettingValueState {
  const defaultValue = inspect?.defaultValue;
  const scopeValue = scope === "workspace" ? inspect?.workspaceValue : inspect?.globalValue;
  const modified = scopeValue !== undefined;

  return {
    effective: modified ? scopeValue : defaultValue,
    scopeValue,
    modified,
    overriddenByWorkspace: scope === "user" ? inspect?.workspaceValue !== undefined : undefined,
    default: defaultValue,
  };
}

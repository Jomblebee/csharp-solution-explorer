// The Options panel: an editor-area view over this extension's own settings, in the spirit of Visual
// Studio's Options dialog. It complements the built-in Settings editor rather than replacing it —
// both toolbar escape hatches lead back there, because this panel deliberately cannot express
// folder scope, per-language overrides or Settings Sync.
//
// The webview is a rendering surface, not a trust boundary: it posts a key and a value, and this
// class re-validates against the descriptor it built before anything reaches `config.update`. Same
// division as the NuGet manager panel.

import * as vscode from "vscode";
import { debounce } from "../shared/debounce.js";
import { errorText } from "../shared/errorText.js";
import { buildPanelHtml } from "../shared/webviewHtml.js";
import { buildSettingsSchema, type SettingDescriptor, type SettingGroupDescriptor } from "./settingsSchema.js";
import { restoresInherited, toValueState, type SettingScope, type SettingValueState } from "./settingValueState.js";
import { validateSettingValue } from "./settingValidation.js";

/** The view type VS Code restores the panel under after a window reload. */
export const OPTIONS_VIEW_TYPE = "csharpSolutionExplorer.options";

/** The section every setting this panel edits lives under. */
const CONFIG_PREFIX = "csharpSolutionExplorer";

/** Collapses a burst of configuration events — our own writes echo back through the same event. */
const CONFIG_CHANGE_DEBOUNCE_MS = 150;

interface PersistedState {
  scope?: SettingScope;
}

type Incoming =
  | { type: "ready"; scope?: SettingScope }
  | { type: "setScope"; scope: SettingScope }
  | { type: "update"; key: string; scope: SettingScope; value: unknown }
  | { type: "reset"; key: string; scope: SettingScope }
  | { type: "browse"; key: string; scope: SettingScope }
  | { type: "openJson"; scope: SettingScope; key?: string }
  | { type: "openNativeSettings" };

type Outgoing =
  | {
      type: "schema";
      groups: SettingGroupDescriptor[];
      hasWorkspace: boolean;
      workspaceLabel?: string;
    }
  | { type: "values"; scope: SettingScope; values: Record<string, SettingValueState> }
  | { type: "updated"; key: string; scope: SettingScope; state: SettingValueState }
  | { type: "error"; message: string };

export class OptionsPanel {
  private static current: OptionsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly groups: SettingGroupDescriptor[];
  private readonly descriptors: Map<string, SettingDescriptor>;
  private readonly extensionId: string;
  private scope: SettingScope = "user";

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (OptionsPanel.current) {
      OptionsPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(OPTIONS_VIEW_TYPE, "C# Solution Explorer: Options", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    OptionsPanel.current = new OptionsPanel(panel, context);
  }

  /**
   * Rebuilds the panel VS Code restored after a window reload. Unlike the NuGet manager there is
   * nothing that can have gone missing — the settings are always there — so the panel always revives.
   */
  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, persisted: PersistedState | undefined): void {
    OptionsPanel.current?.dispose();
    OptionsPanel.current = new OptionsPanel(panel, context, persisted?.scope);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    initialScope?: SettingScope,
  ) {
    this.groups = buildSettingsSchema(readContributes(context));
    this.extensionId = context.extension.id;
    this.descriptors = new Map(
      this.groups.flatMap((group) => group.settings.map((setting) => [setting.key, setting] as const)),
    );
    if (initialScope === "workspace" && hasWorkspace()) {
      this.scope = "workspace";
    }

    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "solution-explorer-icon.svg");
    this.panel.webview.html = buildPanelHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      title: "C# Solution Explorer Options",
      styles: ["shared/panel.css", "options/main.css"],
      scripts: ["shared/dom.js", "options/fields.js", "options/nav.js", "options/main.js"],
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: Incoming) => void this.handle(msg), null, this.disposables);

    // Settings can change from the built-in editor, from Settings Sync, or from our own writes. One
    // debounced snapshot covers all three; the webview leaves a focused field alone so a live update
    // cannot eat the caret.
    const pushValues = debounce(() => this.sendValues(), CONFIG_CHANGE_DEBOUNCE_MS);
    this.disposables.push(
      { dispose: () => pushValues.cancel() },
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_PREFIX)) {
          pushValues();
        }
      }),
    );
  }

  private post(message: Outgoing): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(msg: Incoming): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          if (msg.scope === "workspace" && hasWorkspace()) {
            this.scope = "workspace";
          }
          this.post({
            type: "schema",
            groups: this.groups,
            hasWorkspace: hasWorkspace(),
            workspaceLabel: workspaceLabel(),
          });
          this.sendValues();
          break;

        case "setScope":
          this.scope = msg.scope === "workspace" && hasWorkspace() ? "workspace" : "user";
          this.sendValues();
          break;

        case "update":
          await this.applyUpdate(msg.key, msg.scope, msg.value);
          break;

        case "reset":
          await this.applyUpdate(msg.key, msg.scope, undefined);
          break;

        case "browse":
          await this.browseForPath(msg.key, msg.scope);
          break;

        case "openJson":
          await openSettingsJson(msg.scope);
          break;

        case "openNativeSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.extensionId}`);
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: errorText(err) });
    }
  }

  /**
   * Writes one key. `undefined` is the reset path — it removes the entry rather than storing a value,
   * which is what makes "Reset" restore inheritance instead of pinning the current default.
   */
  private async applyUpdate(key: string, scope: SettingScope, value: unknown): Promise<void> {
    const descriptor = this.descriptors.get(key);
    if (!descriptor) {
      // A webview left over from before a reload, showing a setting this build no longer contributes.
      this.post({ type: "error", message: `${key} is not a known setting. Reload the window.` });
      return;
    }
    if (scope === "workspace" && !hasWorkspace()) {
      this.post({ type: "error", message: "Open a folder to store workspace settings." });
      return;
    }
    if (scope === "workspace" && descriptor.userOnly) {
      this.post({ type: "error", message: `${key} cannot be set per workspace.` });
      return;
    }

    if (value !== undefined) {
      const validation = validateSettingValue(descriptor, value);
      if (!validation.ok) {
        this.post({ type: "error", message: validation.message });
        return;
      }
      value = validation.value;
      // Choosing the value the setting would have anyway is a reset, not a write — otherwise the
      // entry stays in settings.json and the row keeps its modified dot with nothing to reset to.
      if (restoresInherited(vscode.workspace.getConfiguration().inspect(key), scope, value)) {
        value = undefined;
      }
    }

    const target = scope === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration().update(key, value, target);
    // Echo the stored state straight back: the debounced onDidChangeConfiguration push follows, but
    // this keeps the row's marker in step with the click that caused it.
    this.post({ type: "updated", key, scope, state: this.readState(key, scope) });
  }

  /** Fills a path-valued setting from the native file dialog, since typing a path is error-prone. */
  private async browseForPath(key: string, scope: SettingScope): Promise<void> {
    const descriptor = this.descriptors.get(key);
    if (!descriptor?.pathHint) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Select",
      title: descriptor.label,
    });
    if (picked && picked.length > 0) {
      await this.applyUpdate(key, scope, picked[0].fsPath);
    }
  }

  private sendValues(): void {
    const values: Record<string, SettingValueState> = {};
    for (const key of this.descriptors.keys()) {
      values[key] = this.readState(key, this.scope);
    }
    this.post({ type: "values", scope: this.scope, values });
  }

  private readState(key: string, scope: SettingScope): SettingValueState {
    return toValueState(vscode.workspace.getConfiguration().inspect(key), scope);
  }

  private dispose(): void {
    OptionsPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/** The manifest is data, not a typed API — `buildSettingsSchema` narrows it. */
function readContributes(context: vscode.ExtensionContext): unknown {
  const manifest: unknown = context.extension.packageJSON;
  return typeof manifest === "object" && manifest !== null
    ? (manifest as Record<string, unknown>).contributes
    : undefined;
}

function hasWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

function workspaceLabel(): string | undefined {
  return vscode.workspace.name;
}

/**
 * Opens the JSON behind the active scope. VS Code owns both files (and creates the workspace one on
 * demand), so this defers to its commands rather than resolving paths itself.
 */
async function openSettingsJson(scope: SettingScope): Promise<void> {
  const command =
    scope === "workspace" && hasWorkspace()
      ? "workbench.action.openWorkspaceSettingsFile"
      : "workbench.action.openSettingsJson";
  await vscode.commands.executeCommand(command);
}

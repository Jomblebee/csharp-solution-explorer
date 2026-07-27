// The Project Properties panel: Visual Studio's project pages for a single project — csproj properties
// and NuGet package metadata — as an editor tab.
//
// Rendering order matters here. The filesystem read is fast, so the panel shows declared values
// immediately and asks MSBuild in the background; the evaluated values arrive as a second message and
// unlock the fields whose provenance they explain. Nothing MSBuild-related runs at activation or while
// the tree renders.
//
// As in the NuGet panel, the webview posts intent and this class decides: every write is re-checked
// against the freshly-read project file by the service before it happens.

import * as vscode from "vscode";
import * as path from "node:path";
import { debounce } from "../../shared/debounce.js";
import { getLaunchSettingsPath } from "../parsers/launchSettingsReader.js";
import { errorText } from "../../shared/errorText.js";
import { buildPanelHtml } from "../../shared/webviewHtml.js";
import { PROPERTY_CATALOG, PROPERTY_SECTIONS, type PropertyDefinition } from "./propertyCatalog.js";
import type { PropertyStatus } from "./propertyClassification.js";
import {
  ProjectPropertiesService,
  type ProjectPropertiesState,
  type WriteReport,
} from "./projectPropertiesService.js";
import {
  LaunchProfileEditor,
  type ProfileFlagField,
  type ProfileTextField,
  type ProfileView,
} from "./launchProfileEditing.js";

/** The view type VS Code restores the panel under after a window reload. */
export const PROJECT_PROPERTIES_VIEW_TYPE = "csharpSolutionExplorer.projectProperties";

/** Collapses a burst of file-watcher events on the project file. */
const WATCH_DEBOUNCE_MS = 300;

interface PersistedState {
  projectFsPath?: string;
  framework?: string;
}

type Incoming =
  | { type: "ready"; framework?: string }
  | { type: "setProperty"; tag: string; value: string }
  | { type: "clearProperty"; tag: string }
  | { type: "overrideProperty"; tag: string; value: string }
  | { type: "selectFramework"; framework: string }
  | { type: "openProjectFile"; line?: number }
  | { type: "openInheritedFile"; fsPath: string; line?: number }
  | { type: "openLaunchSettings" }
  | { type: "profileAdd" }
  | { type: "profileDuplicate"; source: string }
  | { type: "profileDelete"; name: string }
  | { type: "profileRename"; name: string }
  | { type: "profileText"; name: string; field: ProfileTextField; value: string }
  | { type: "profileFlag"; name: string; field: ProfileFlagField; value: boolean }
  | { type: "profileEnvironment"; name: string; environment: Record<string, string> }
  | { type: "refresh" };

type Outgoing =
  | {
      type: "catalog";
      sections: typeof PROPERTY_SECTIONS;
      definitions: PropertyDefinition[];
    }
  | { type: "projectState"; state: SerializableState; evaluating: boolean }
  | { type: "evaluated"; properties: PropertyStatus[]; framework?: string; available: boolean }
  | { type: "writeResult"; report: WriteReport; properties: PropertyStatus[] }
  | { type: "profiles"; profiles: ProfileView[]; hasLaunchSettings: boolean }
  | { type: "externalChange" }
  | { type: "error"; message: string };

/** What the webview receives — the service's state plus display-only extras. */
interface SerializableState extends ProjectPropertiesState {
  inheritedFileNames: string[];
}

export class ProjectPropertiesPanel {
  /** One panel per project, so two projects can be compared side by side. */
  private static readonly open = new Map<string, ProjectPropertiesPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly service: ProjectPropertiesService;
  private readonly profiles: LaunchProfileEditor;
  private framework: string | undefined;
  /** Bumped per evaluation so a slow answer for an old framework cannot overwrite a newer one. */
  private evaluationGeneration = 0;

  static createOrShow(context: vscode.ExtensionContext, projectUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const existing = ProjectPropertiesPanel.open.get(projectUri.fsPath);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PROJECT_PROPERTIES_VIEW_TYPE,
      `${path.basename(projectUri.fsPath, path.extname(projectUri.fsPath))}: Properties`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    ProjectPropertiesPanel.open.set(projectUri.fsPath, new ProjectPropertiesPanel(panel, context, projectUri));
  }

  /** Rebuilds a restored panel, or closes it when the project it described is gone. */
  static async revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    persisted: PersistedState | undefined,
  ): Promise<void> {
    const projectFsPath = persisted?.projectFsPath;
    if (!projectFsPath) {
      panel.dispose();
      return;
    }
    const projectUri = vscode.Uri.file(projectFsPath);
    try {
      await vscode.workspace.fs.stat(projectUri);
    } catch {
      panel.dispose();
      return;
    }
    ProjectPropertiesPanel.open.get(projectFsPath)?.dispose();
    ProjectPropertiesPanel.open.set(
      projectFsPath,
      new ProjectPropertiesPanel(panel, context, projectUri, persisted.framework),
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly projectUri: vscode.Uri,
    framework?: string,
  ) {
    this.service = new ProjectPropertiesService(projectUri);
    this.profiles = new LaunchProfileEditor(projectUri);
    this.framework = framework;

    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "solution-explorer-icon.svg");
    this.panel.webview.html = buildPanelHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      title: "Project Properties",
      styles: ["shared/panel.css", "projectProperties/main.css"],
      scripts: [
        "shared/dom.js",
        "projectProperties/properties.js",
        "projectProperties/profiles.js",
        "projectProperties/main.js",
      ],
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: Incoming) => void this.handle(msg), null, this.disposables);
    this.watchProjectFile();
    this.watchLaunchSettings();
  }

  private post(message: Outgoing): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(msg: Incoming): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          // A webview restored by VS Code remembers the framework it was showing; a fresh one does not.
          this.framework = this.framework ?? msg.framework;
          this.post({ type: "catalog", sections: PROPERTY_SECTIONS, definitions: PROPERTY_CATALOG });
          await this.sendState();
          await this.sendProfiles();
          void this.evaluate();
          break;

        case "refresh":
          this.service.invalidateEvaluation();
          await this.sendState();
          await this.sendProfiles();
          void this.evaluate();
          break;

        case "selectFramework":
          this.framework = msg.framework;
          await this.sendState();
          void this.evaluate();
          break;

        case "setProperty":
          await this.applyWrite(await this.service.writeProperty(msg.tag, msg.value));
          break;

        case "overrideProperty":
          await this.applyWrite(await this.service.writeProperty(msg.tag, msg.value, "override"));
          break;

        case "clearProperty":
          await this.applyWrite(await this.service.clearProperty(msg.tag));
          break;

        case "openProjectFile":
          await revealInEditor(this.projectUri, msg.line);
          break;

        case "openInheritedFile":
          await revealInEditor(vscode.Uri.file(msg.fsPath), msg.line);
          break;

        case "openLaunchSettings":
          await revealInEditor(this.launchSettingsUri());
          break;

        // Names and the delete confirmation go through VS Code's own dialogs rather than webview
        // widgets: the duplicate-name check lives with the profile editor, and a destructive action
        // deserves the modal the rest of the extension uses.
        case "profileAdd":
          await this.promptAdd();
          break;

        case "profileDuplicate":
          await this.promptDuplicate(msg.source);
          break;

        case "profileDelete":
          await this.promptDelete(msg.name);
          break;

        case "profileRename":
          await this.promptRename(msg.name);
          break;

        case "profileText":
          await this.editProfiles(() => this.profiles.setTextField(msg.name, msg.field, msg.value));
          break;

        case "profileFlag":
          await this.editProfiles(() => this.profiles.setFlag(msg.name, msg.field, msg.value));
          break;

        case "profileEnvironment":
          await this.editProfiles(() => this.profiles.setEnvironment(msg.name, msg.environment));
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: errorText(err) });
    }
  }

  private async applyWrite(report: WriteReport): Promise<void> {
    const state = await this.service.read(this.framework);
    this.post({ type: "writeResult", report, properties: state.properties });
    // A write can change what other fields inherit — clearing one property may reveal an imported
    // value — so the evaluation is redone rather than reused.
    void this.evaluate();
  }

  /**
   * Runs one profile edit and re-reads the file afterwards. A failed edit still triggers the re-read, so
   * the panel shows the file as it actually is rather than the state the failed change implied.
   */
  private async editProfiles(edit: () => Promise<void>): Promise<void> {
    try {
      await edit();
    } catch (err) {
      this.post({ type: "error", message: errorText(err) });
    }
    await this.sendProfiles();
  }

  private async promptAdd(): Promise<void> {
    const commandName = await vscode.window.showQuickPick(["Project", "Executable", "IISExpress"], {
      title: "New launch profile",
      placeHolder: "How should this profile start the project?",
    });
    if (!commandName) {
      return;
    }
    const name = await this.promptName("New launch profile", "");
    if (name === undefined) {
      return;
    }
    await this.editProfiles(() => this.profiles.add(name, commandName));
  }

  private async promptDuplicate(source: string): Promise<void> {
    const name = await this.promptName("Duplicate launch profile", `${source} copy`);
    if (name === undefined) {
      return;
    }
    await this.editProfiles(() => this.profiles.duplicate(source, name));
  }

  private async promptRename(current: string): Promise<void> {
    const name = await this.promptName("Rename launch profile", current);
    if (name === undefined || name === current) {
      return;
    }
    await this.editProfiles(() => this.profiles.rename(current, name));
  }

  private async promptDelete(name: string): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete the launch profile "${name}"?`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") {
      return;
    }
    await this.editProfiles(() => this.profiles.delete(name));
  }

  private async promptName(title: string, value: string): Promise<string | undefined> {
    const existing = (await this.profiles.read()).map((profile) => profile.name.toLowerCase());
    return vscode.window.showInputBox({
      title,
      value,
      prompt: "Profile name",
      validateInput: (input) => {
        const trimmed = input.trim();
        if (trimmed === "") {
          return "A profile needs a name.";
        }
        if (trimmed.toLowerCase() !== value.toLowerCase() && existing.includes(trimmed.toLowerCase())) {
          return `A profile named "${trimmed}" already exists.`;
        }
        return undefined;
      },
    });
  }

  private async sendProfiles(): Promise<void> {
    const profiles = await this.profiles.read();
    this.post({ type: "profiles", profiles, hasLaunchSettings: profiles.length > 0 });
  }

  private launchSettingsUri(): vscode.Uri {
    return vscode.Uri.file(getLaunchSettingsPath(path.dirname(this.projectUri.fsPath)));
  }

  private async sendState(): Promise<void> {
    const state = await this.service.read(this.framework);
    this.framework = state.selectedFramework;
    this.post({
      type: "projectState",
      state: { ...state, inheritedFileNames: state.inheritedFiles.map((file) => path.basename(file)) },
      evaluating: true,
    });
  }

  /** Asks MSBuild in the background and pushes the result; a failure is reported, not thrown. */
  private async evaluate(): Promise<void> {
    const generation = ++this.evaluationGeneration;
    const framework = this.framework;
    const properties = await this.service.evaluate(framework);
    if (generation !== this.evaluationGeneration) {
      return; // a newer evaluation started meanwhile; its answer is the one that counts
    }
    this.post({
      type: "evaluated",
      properties: properties ?? [],
      framework,
      available: properties !== undefined,
    });
  }

  /**
   * Reacts to the project file changing underneath us — a `dotnet` command, a hand edit, another panel.
   * Our own writes are filtered out by comparing the text, not by a timer: a timer would either miss a
   * slow write or swallow a fast outside one.
   */
  private watchProjectFile(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(this.projectUri.fsPath);
    const onChange = debounce(() => void this.handleExternalChange(), WATCH_DEBOUNCE_MS);
    this.disposables.push(
      watcher,
      { dispose: () => onChange.cancel() },
      watcher.onDidChange(() => onChange()),
      watcher.onDidDelete(() => this.panel.dispose()),
    );
  }

  /**
   * launchSettings.json is also written by the QuickPick profile editor and by `dotnet new`. Both write
   * through the same edit layer, so the file stays consistent — but this panel's copy would go stale, so
   * it re-reads rather than trusting what it last rendered.
   */
  private watchLaunchSettings(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(this.launchSettingsUri().fsPath);
    const reload = debounce(() => void this.sendProfiles(), WATCH_DEBOUNCE_MS);
    this.disposables.push(
      watcher,
      { dispose: () => reload.cancel() },
      watcher.onDidChange(() => reload()),
      watcher.onDidCreate(() => reload()),
      watcher.onDidDelete(() => reload()),
    );
  }

  private async handleExternalChange(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.projectUri);
      if (!this.service.isForeignChange(new TextDecoder().decode(bytes))) {
        return;
      }
    } catch {
      return; // deleted mid-flight; onDidDelete closes the panel
    }
    this.service.invalidateEvaluation();
    this.post({ type: "externalChange" });
    await this.sendState();
    void this.evaluate();
  }

  private dispose(): void {
    ProjectPropertiesPanel.open.delete(this.projectUri.fsPath);
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/** Opens a file and puts the cursor on `line` (0-based), so "declared at" is one click away. */
async function revealInEditor(uri: vscode.Uri, line?: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  if (line !== undefined && line >= 0 && line < document.lineCount) {
    const position = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

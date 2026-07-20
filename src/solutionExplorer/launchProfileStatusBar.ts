import * as path from "node:path";
import * as vscode from "vscode";
import { describeActiveProfile, getEffectiveLaunchBrowser } from "./launchProfileCommands.js";
import { getStartupProjectFsPath, onDidChangeLaunchProfileState } from "./launchProfileState.js";
import { MANAGE_LAUNCH_COMMAND_ID } from "./types.js";

/**
 * Shows the startup project and its launch profile — the Visual-Studio-toolbar equivalent. Stays
 * visible even with no startup project yet, so there is always an obvious place to pick one; the
 * click opens a small menu to change either the startup project or the launch profile.
 */
export class LaunchProfileStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  /** Guards against an out-of-order render when state changes while a read is in flight. */
  private renderToken = 0;

  constructor() {
    // Priority 1 puts this left of the language server's item (priority 0).
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    this.item.command = MANAGE_LAUNCH_COMMAND_ID;
    this.subscription = onDidChangeLaunchProfileState(() => void this.render());
    void this.render();
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const startup = getStartupProjectFsPath();
    if (!startup) {
      // No startup project yet: still visible, doubling as the "pick one" entry point.
      this.item.text = "$(play) Select startup project";
      this.item.tooltip = "No startup project selected. Click to choose the project to debug or run.";
      this.item.show();
      return;
    }

    const projectUri = vscode.Uri.file(startup);
    const rootDir = vscode.Uri.file(path.dirname(startup));
    const name = path.basename(startup, path.extname(startup));
    const { label, profile } = await describeActiveProfile(projectUri, rootDir);
    const launchBrowser = await getEffectiveLaunchBrowser(projectUri, rootDir);
    if (token !== this.renderToken) {
      return;
    }

    this.item.text = `$(play) ${name} — ${label}${launchBrowser ? " $(globe)" : ""}`;
    this.item.tooltip = [
      `Startup project: ${startup}`,
      `Launch profile: ${label}`,
      `Launch browser: ${launchBrowser ? "on" : "off"}`,
      profile?.applicationUrl ? `URL: ${profile.applicationUrl}` : undefined,
      "Click to change the startup project, launch profile, or browser launch",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

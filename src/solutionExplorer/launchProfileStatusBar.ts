import * as path from "node:path";
import * as vscode from "vscode";
import { describeActiveProfile } from "./launchProfileCommands.js";
import { getStartupProjectFsPath, onDidChangeLaunchProfileState } from "./launchProfileState.js";
import { SELECT_LAUNCH_PROFILE_COMMAND_ID, SELECT_STARTUP_PROJECT_COMMAND_ID } from "./types.js";

/**
 * The Visual-Studio-toolbar equivalent, split in two: one item for the startup project, one for its
 * launch profile. Each is a single click straight into its own picker — no intermediate menu. Both
 * stay visible with no startup project yet, so there is always an obvious place to pick one.
 */
export class LaunchProfileStatusBar implements vscode.Disposable {
  private readonly projectItem: vscode.StatusBarItem;
  private readonly profileItem: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  /** Guards against an out-of-order render when state changes while a read is in flight. */
  private renderToken = 0;

  constructor() {
    // Priorities 3 and 2 keep both left of the language server's item (priority 0), in this order.
    this.projectItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
    this.projectItem.command = SELECT_STARTUP_PROJECT_COMMAND_ID;
    this.profileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
    this.profileItem.command = SELECT_LAUNCH_PROFILE_COMMAND_ID;
    this.subscription = onDidChangeLaunchProfileState(() => void this.render());
    void this.render();
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const startup = getStartupProjectFsPath();
    if (!startup) {
      this.projectItem.text = "$(play-circle) Select startup project";
      this.projectItem.tooltip = "No startup project selected. Click to choose the project to debug or run.";
      // The profile picker asks for a project first, so this stays useful without one.
      this.profileItem.text = "$(rocket) Select launch profile";
      this.profileItem.tooltip = "Click to choose a startup project and its launch profile.";
      this.show();
      return;
    }

    const projectUri = vscode.Uri.file(startup);
    const rootDir = vscode.Uri.file(path.dirname(startup));
    const name = path.basename(startup, path.extname(startup));
    const { label, profile } = await describeActiveProfile(projectUri, rootDir);
    if (token !== this.renderToken) {
      return;
    }

    this.projectItem.text = `$(play-circle) ${name}`;
    this.projectItem.tooltip = `Startup project: ${startup}\nClick to change the startup project`;
    this.profileItem.text = `$(rocket) ${label}`;
    this.profileItem.tooltip = [
      `Launch profile: ${label}`,
      profile?.applicationUrl ? `URL: ${profile.applicationUrl}` : undefined,
      "Click to change the launch profile",
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    this.show();
  }

  private show(): void {
    this.projectItem.show();
    this.profileItem.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.projectItem.dispose();
    this.profileItem.dispose();
  }
}

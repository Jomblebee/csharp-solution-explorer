// Entry points for the Project Properties panel: from a project node's context menu, and from the
// Command Palette, where there is no node to work from and the project has to be picked.

import * as vscode from "vscode";
import { resolveOwningProjectUri } from "../commandUtils.js";
import { findWorkspaceProjects } from "../workspaceProjects.js";
import { ProjectPropertiesPanel } from "../projectProperties/projectPropertiesPanel.js";

export async function openProjectProperties(item: unknown, context: vscode.ExtensionContext): Promise<void> {
  // A tree node, a project Uri (the launch-profile menu passes one), or nothing at all from the palette.
  const projectUri =
    (item instanceof vscode.Uri ? item : resolveOwningProjectUri(item)) ?? (await pickProject());
  if (!projectUri) {
    return;
  }
  ProjectPropertiesPanel.createOrShow(context, projectUri);
}

/** Offers the workspace's projects when the command was invoked without a tree selection. */
async function pickProject(): Promise<vscode.Uri | undefined> {
  const projects = await findWorkspaceProjects();
  if (projects.length === 0) {
    void vscode.window.showInformationMessage("No C# projects were found in this workspace.");
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0].uri;
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name,
      description: vscode.workspace.asRelativePath(project.uri),
      uri: project.uri,
    })),
    { title: "Project Properties", placeHolder: "Select a project" },
  );
  return picked?.uri;
}

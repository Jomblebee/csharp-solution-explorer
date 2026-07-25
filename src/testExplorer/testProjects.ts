// Discovers the workspace's test projects for the Test Explorer. Reuses the tree's project discovery
// (findWorkspaceProjects) and filters with the pure isTestProject classifier — the same decoupled
// shape as workspaceProjects' own isProjectDebuggable, so it does not depend on the non-exported
// classifyProject.

import * as vscode from "vscode";
import { findWorkspaceProjects, type TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { isTestProject } from "./testProjectClassifier.js";

export async function findTestProjects(): Promise<TargetProject[]> {
  const projects = await findWorkspaceProjects();
  const flags = await Promise.all(projects.map((project) => isProjectTest(project.uri)));
  return projects.filter((_, index) => flags[index]);
}

async function isProjectTest(uri: vscode.Uri): Promise<boolean> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return isTestProject(text);
  } catch {
    return false;
  }
}

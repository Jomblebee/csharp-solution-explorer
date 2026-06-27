import * as vscode from "vscode";
import { registerSolutionExplorerCommands } from "./solutionExplorer/commands.js";
import { SolutionTreeDataProvider } from "./solutionExplorer/solutionTreeDataProvider.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SolutionTreeDataProvider();
  const treeView = vscode.window.createTreeView("csharpSolutionExplorer.view", {
    treeDataProvider: provider,
  });

  registerSolutionExplorerCommands(context, provider);

  context.subscriptions.push(provider, treeView);
}

export function deactivate(): void {
  // Disposables are released via context.subscriptions; nothing else to clean up.
}

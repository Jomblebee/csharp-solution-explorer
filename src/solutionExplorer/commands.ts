import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import { OPEN_FILE_COMMAND_ID, REFRESH_COMMAND_ID } from "./types.js";

export function registerSolutionExplorerCommands(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND_ID, () => provider.refresh()),
    vscode.commands.registerCommand(OPEN_FILE_COMMAND_ID, (uri: vscode.Uri) =>
      vscode.window.showTextDocument(uri),
    ),
  );
}

import * as vscode from "vscode";
import { registerSolutionExplorerCommands } from "./solutionExplorer/commands.js";
import { SolutionTreeDragAndDropController } from "./solutionExplorer/dragAndDropController.js";
import { SolutionTreeDataProvider } from "./solutionExplorer/solutionTreeDataProvider.js";
import { SolutionExplorerTreeItem } from "./solutionExplorer/treeItems.js";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SolutionTreeDataProvider();
  const treeView = vscode.window.createTreeView("csharpSolutionExplorer.view", {
    treeDataProvider: provider,
    dragAndDropController: new SolutionTreeDragAndDropController(provider),
  });

  registerSolutionExplorerCommands(context, provider, treeView);
  registerAutoReveal(context, provider, treeView);

  context.subscriptions.push(provider, treeView);
}

/** Selects the active editor's file in the tree when `csharpSolutionExplorer.autoReveal` is on. */
function registerAutoReveal(
  context: vscode.ExtensionContext,
  provider: SolutionTreeDataProvider,
  treeView: vscode.TreeView<SolutionExplorerTreeItem>,
): void {
  const revealActive = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    const autoReveal = vscode.workspace
      .getConfiguration("csharpSolutionExplorer")
      .get<boolean>("autoReveal", true);
    if (!autoReveal || !editor || !treeView.visible || editor.document.uri.scheme !== "file") {
      return;
    }
    try {
      const item = await provider.findTreeItem(editor.document.uri);
      if (item) {
        await treeView.reveal(item, { select: true, focus: false, expand: true });
      }
    } catch {
      // Auto-reveal is best-effort; a transient tree/read error must not surface to the user.
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void revealActive(editor)),
    // Also sync when the view becomes visible, so switching to it lands on the current file.
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        void revealActive(vscode.window.activeTextEditor);
      }
    }),
  );
}

export function deactivate(): void {
  // Disposables are released via context.subscriptions; nothing else to clean up.
}

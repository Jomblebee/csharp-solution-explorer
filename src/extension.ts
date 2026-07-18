import * as vscode from "vscode";
import { activateLanguageServer } from "./languageServer/activate.js";
import { NUGET_MANAGER_VIEW_TYPE, NugetManagerPanel } from "./nuget/nugetManagerPanel.js";
import { registerSolutionExplorerCommands } from "./solutionExplorer/commands.js";
import { checkDotnetSdk } from "./solutionExplorer/dotnetSdkNotifier.js";
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

  context.subscriptions.push(
    provider,
    treeView,
    // Bring the NuGet manager back with its solution after a window reload, instead of an empty panel.
    vscode.window.registerWebviewPanelSerializer(NUGET_MANAGER_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state: unknown) =>
        NugetManagerPanel.revive(panel, context, provider, state as { solutionFsPath?: string } | undefined),
    }),
  );

  // The bundled C# language server (Roslyn): downloads on first use and runs unless the Microsoft
  // C# extension is present. Best-effort — never blocks activation of the Solution Explorer.
  activateLanguageServer(context);

  // Non-blocking, best-effort: warn once at startup if no SDK matching the solution's needs is installed.
  void checkDotnetSdk();
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
        // No `expand: true`: reveal always expands ancestors so the file becomes visible (e.g. a
        // nested child's parent), but we must not expand the target node itself — otherwise focusing
        // a nesting parent (e.g. a .razor with companions) would auto-expand it on every open.
        await treeView.reveal(item, { select: true, focus: false });
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

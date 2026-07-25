import * as vscode from "vscode";
import { activateDebugger } from "./debug/activate.js";
import { activateLanguageServer } from "./languageServer/activate.js";
import { NUGET_MANAGER_VIEW_TYPE, NugetManagerPanel } from "./nuget/nugetManagerPanel.js";
import { activateTestExplorer } from "./testExplorer/activate.js";
import { registerSolutionExplorerCommands } from "./solutionExplorer/commands/commands.js";
import { checkDotnetSdk } from "./solutionExplorer/dotnetSdkNotifier.js";
import { SolutionTreeDragAndDropController } from "./solutionExplorer/tree/dragAndDropController.js";
import {
  disposeLaunchProfileState,
  initLaunchProfileState,
  onDidChangeLaunchProfileState,
} from "./solutionExplorer/launchProfiles/launchProfileState.js";
import { LaunchProfileStatusBar } from "./solutionExplorer/launchProfiles/launchProfileStatusBar.js";
import { SolutionTreeDataProvider } from "./solutionExplorer/tree/solutionTreeDataProvider.js";
import { SolutionExplorerTreeItem } from "./solutionExplorer/tree/treeItems.js";

export function activate(context: vscode.ExtensionContext): void {
  // Must precede the provider: it reads the startup project synchronously while building nodes,
  // so hydrating later would leave the first render undecorated.
  initLaunchProfileState(context);

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
    new LaunchProfileStatusBar(),
    // Redraw the startup decoration when the startup project changes.
    onDidChangeLaunchProfileState(() => provider.refresh()),
    { dispose: disposeLaunchProfileState },
    // Bring the NuGet manager back with its solution after a window reload, instead of an empty panel.
    vscode.window.registerWebviewPanelSerializer(NUGET_MANAGER_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state: unknown) =>
        NugetManagerPanel.revive(panel, context, provider, state as { solutionFsPath?: string } | undefined),
    }),
  );

  // The bundled C# language server (Roslyn): downloads on first use and runs unless the Microsoft
  // C# extension is present. Best-effort — never blocks activation of the Solution Explorer.
  activateLanguageServer(context);

  // The .NET debugger (netcoredbg): the adapter is downloaded on the first debug session, never at
  // activation.
  activateDebugger(context);

  // The native Test Explorer: lists test projects, runs them with `dotnet test`, and debugs
  // individual tests by attaching netcoredbg. Off when its config flag is disabled.
  activateTestExplorer(context);

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

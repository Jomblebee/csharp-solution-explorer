// Entry point for the C# language server subsystem, kept out of the extension's main activate() so
// the wiring stays focused. Creates the shared state, the controller, the dedicated status UI, and
// the triggers that restart the server when its settings change or the Microsoft C# extension is
// installed/removed.

import * as vscode from "vscode";
import { LanguageServerController } from "./languageServerController.js";
import { LanguageServerStatusBar, LanguageServerStatusView } from "./languageServerStatusView.js";
import { ServerStateStore } from "./serverState.js";

const MS_EXTENSION_ID = "ms-dotnettools.csharp";

export function activateLanguageServer(context: vscode.ExtensionContext): void {
  const state = new ServerStateStore();
  const output = vscode.window.createOutputChannel("C# Language Server");
  const controller = new LanguageServerController(context, state, output);

  const statusView = new LanguageServerStatusView(state);
  const statusBar = new LanguageServerStatusBar(state);

  let msExtPresent = Boolean(vscode.extensions.getExtension(MS_EXTENSION_ID));

  context.subscriptions.push(
    state,
    { dispose: () => void controller.dispose() },
    statusBar,
    vscode.window.registerTreeDataProvider("csharpSolutionExplorer.languageServerView", statusView),
    vscode.commands.registerCommand("csharpSolutionExplorer.languageServer.restart", () =>
      controller.restart(),
    ),
    vscode.commands.registerCommand("csharpSolutionExplorer.languageServer.showLogs", () =>
      controller.showLogs(),
    ),
    vscode.commands.registerCommand("csharpSolutionExplorer.languageServer.openCacheFolder", () =>
      openCacheFolder(context),
    ),
    // Restart when a language-server setting changes (enable/disable, version, path, log level).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("csharpSolutionExplorer.languageServer")) {
        void controller.restart();
      }
    }),
    // Re-evaluate only when the Microsoft C# extension appears/disappears, to avoid needless restarts.
    vscode.extensions.onDidChange(() => {
      const present = Boolean(vscode.extensions.getExtension(MS_EXTENSION_ID));
      if (present !== msExtPresent) {
        msExtPresent = present;
        void controller.restart();
      }
    }),
  );

  void controller.start();
}

/** Opens the global server cache directory in the OS file manager (creating it if absent). */
async function openCacheFolder(context: vscode.ExtensionContext): Promise<void> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, "roslyn");
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // Directory may already exist; revealing it below is what matters.
  }
  await vscode.commands.executeCommand("revealFileInOS", dir);
}

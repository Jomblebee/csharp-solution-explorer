// Wires up the debugger: the adapter factory, the configuration provider (registered twice — see
// below), and the debug-related commands. Mirrors `languageServer/activate.ts`.

import * as vscode from "vscode";
import { clearDebuggerCache } from "./netcoredbgDownloader.js";
import { DEBUG_TYPE } from "./debugConfig.js";
import { NetcoredbgConfigurationProvider, setAsDefaultDebugger } from "./debugConfigurationProvider.js";
import { CONFIG_SECTION } from "./debugSettings.js";
import { DebuggerStateStore } from "./debugState.js";
import { startDebuggingInExternalTerminal } from "./externalTerminal/externalTerminalDebug.js";
import { registerF5Ownership } from "./f5Ownership.js";
import { NetcoredbgDescriptorFactory } from "./netcoredbgAdapter.js";

export function activateDebugger(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enabled", true);
  // Created unconditionally (cheap: an event emitter and an output channel) so the F5 external-
  // terminal flow can reuse the same instances whether it is reached from that command or from F5
  // itself — `startDebugging` below never calls it when `enabled` is false.
  const state = new DebuggerStateStore();
  const output = vscode.window.createOutputChannel("C# Debugger");
  context.subscriptions.push(state, output);

  // Wired up even when the debugger is off: it reads `enabled` as a snapshot and simply never claims
  // F5, while its commands stay in the palette and defer to VS Code's own actions.
  registerF5Ownership(context, {
    debuggerEnabled: enabled,
    startInTerminal: (host) => startDebuggingInExternalTerminal(state, output, host),
  });
  if (!enabled) {
    return;
  }

  const provider = new NetcoredbgConfigurationProvider(state, output);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      DEBUG_TYPE,
      new NetcoredbgDescriptorFactory(context, state, output),
    ),
    // The full provider (resolve hooks + provideDebugConfigurations) is registered for the default
    // kind, so its resolve hooks run exactly once per session. The Dynamic kind — which fills the
    // F5 picker / Run and Debug dropdown when there is no launch.json — gets a *provide-only* object:
    // VS Code chains resolve hooks across every registration, so registering the same provider twice
    // would run resolve twice, and the second pass sees the already-resolved config (which no longer
    // carries `project`) and aborts the whole session.
    //
    // The two registrations deliberately provide *different* lists — don't merge them back together.
    // The default kind seeds a newly written launch.json, where every returned entry lands in the
    // file, so it yields one project-less entry. The Dynamic kind only fills a picker and writes
    // nothing, so it lists every project.
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider),
    vscode.debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      { provideDebugConfigurations: () => provider.provideDynamicConfigurations() },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.commands.registerCommand("csharpSolutionExplorer.debug.setAsDefault", () => setAsDefaultDebugger()),
    vscode.commands.registerCommand("csharpSolutionExplorer.debug.startInExternalTerminal", () =>
      startDebuggingInExternalTerminal(state, output),
    ),
    vscode.commands.registerCommand("csharpSolutionExplorer.debug.showLogs", () => output.show(true)),
    vscode.commands.registerCommand("csharpSolutionExplorer.debug.clearCache", async () => {
      await clearDebuggerCache(context.globalStorageUri);
      vscode.window.showInformationMessage("The downloaded .NET debugger was removed. It will be fetched again on the next debug session.");
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === DEBUG_TYPE) {
        state.set({ phase: "idle" });
      }
    }),
  );
}

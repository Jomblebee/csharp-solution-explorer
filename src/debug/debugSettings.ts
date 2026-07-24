// The debugger's configuration section and the "should we step forward at all?" rules, shared by the
// configuration provider and the F5 ownership module so the `auto` semantics exist in one place only.

import * as vscode from "vscode";

export const CONFIG_SECTION = "csharpSolutionExplorer.debug";
export const MS_CSHARP_EXTENSION = "ms-dotnettools.csharp";

export type OfferConfigurationsMode = "always" | "auto" | "never";

export function readOfferConfigurationsMode(): OfferConfigurationsMode {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<OfferConfigurationsMode>("offerConfigurations", "always");
}

export type F5ConsoleMode = "internalConsole" | "integratedTerminal" | "externalTerminal";

/**
 * Whether F5 launches netcoredbg directly (`internalConsole`, output in the Debug Console with no
 * usable stdin) or via the spawn-then-attach flow that gives the program a real console — hosted in
 * either a VS Code integrated terminal (`integratedTerminal`) or a native OS window (`externalTerminal`).
 */
export function readF5ConsoleMode(): F5ConsoleMode {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<F5ConsoleMode>("f5Console", "externalTerminal");
}

export function isMsCsharpInstalled(): boolean {
  return vscode.extensions.getExtension(MS_CSHARP_EXTENSION) !== undefined;
}

/**
 * `always` (default) offers our configurations everywhere, `never` nowhere, and `auto` steps aside
 * when the Microsoft C# extension is installed and already owns the zero-configuration path.
 */
export function shouldOfferConfigurations(): boolean {
  const mode = readOfferConfigurationsMode();
  if (mode === "never") {
    return false;
  }
  if (mode === "auto") {
    return !isMsCsharpInstalled();
  }
  return true;
}

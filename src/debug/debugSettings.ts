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

/** Milliseconds to delay the program's start before attaching, in the external-terminal debug flow. */
export function readExternalTerminalAttachDelayMs(): number {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<number>("externalTerminalAttachDelayMs", 0);
}

export type F5ConsoleMode = "internalConsole" | "externalTerminal";

/** Whether F5 launches netcoredbg directly (Debug Console output) or via the external-terminal attach flow. */
export function readF5ConsoleMode(): F5ConsoleMode {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<F5ConsoleMode>("f5Console", "internalConsole");
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

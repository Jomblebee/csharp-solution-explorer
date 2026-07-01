import * as vscode from "vscode";

export type ClipboardMode = "copy" | "cut";

interface ClipboardState {
  uris: vscode.Uri[];
  mode: ClipboardMode;
}

/** Context key toggled so the Paste menu item only shows when the clipboard holds something. */
const CONTEXT_KEY = "csharpSolutionExplorer.clipboardHasItems";

let state: ClipboardState | undefined;

export function setClipboard(uris: vscode.Uri[], mode: ClipboardMode): void {
  state = uris.length > 0 ? { uris, mode } : undefined;
  void vscode.commands.executeCommand("setContext", CONTEXT_KEY, state !== undefined);
}

export function getClipboard(): ClipboardState | undefined {
  return state;
}

export function clearClipboard(): void {
  state = undefined;
  void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
}

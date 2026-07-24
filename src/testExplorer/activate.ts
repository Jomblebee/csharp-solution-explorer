// Wires up the native Test Explorer. Mirrors debug/activate.ts: reads an `enabled` config flag as a
// snapshot, early-returns when off (a window reload picks up a change), and otherwise creates the
// output channel + TestController, both cleaned up via context.subscriptions.

import * as vscode from "vscode";
import { createTestController } from "./testController.js";

const CONFIG_SECTION = "csharpSolutionExplorer.testExplorer";

export function activateTestExplorer(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enabled", true);
  if (!enabled) {
    return;
  }
  const output = vscode.window.createOutputChannel("C# Tests");
  context.subscriptions.push(output);
  createTestController(context, output);
}

// Wires up the native Test Explorer. Mirrors debug/activate.ts: reads an `enabled` config flag as a
// snapshot, early-returns when off (a window reload picks up a change), and otherwise creates the
// output channel + TestController, both cleaned up via context.subscriptions.

import * as vscode from "vscode";
import { SHOW_TEST_RUN_DASHBOARD_COMMAND_ID } from "../solutionExplorer/types.js";
import { TestRunDashboard } from "./dashboard/testRunDashboard.js";
import { TEST_RUN_DASHBOARD_VIEW_TYPE } from "./dashboard/testRunDashboardPanel.js";
import { createTestController } from "./testController.js";

const CONFIG_SECTION = "csharpSolutionExplorer.testExplorer";

export function activateTestExplorer(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enabled", true);
  if (!enabled) {
    return;
  }
  const output = vscode.window.createOutputChannel("C# Tests");
  const dashboard = new TestRunDashboard(context, output);
  context.subscriptions.push(output, dashboard);
  createTestController(context, output, dashboard);

  // Command and serializer live here rather than beside the other panels' in extension.ts: both need
  // the dashboard instance, which only exists when the test explorer is enabled.
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_TEST_RUN_DASHBOARD_COMMAND_ID, () => dashboard.show()),
    vscode.window.registerWebviewPanelSerializer(TEST_RUN_DASHBOARD_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        dashboard.revive(panel);
        return Promise.resolve();
      },
    }),
  );
}

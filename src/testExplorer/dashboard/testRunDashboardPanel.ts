// The Test Run Dashboard's window: an editor-area webview showing one test run live. This class is
// deliberately thin — it owns the panel and the postMessage boundary, nothing else. Every decision
// (what to aggregate, when to open, what the numbers mean) belongs to testRunDashboard.ts and the
// pure modules next to it, which is what keeps them unit-testable.
//
// The panel does not own the run. Closing the tab must not stop anything, so the dashboard keeps its
// tracker and simply stops having somewhere to post.

import * as vscode from "vscode";
import { buildPanelHtml } from "../../shared/webviewHtml.js";
import type { Incoming, Outgoing } from "./dashboardProtocol.js";

/** The view type VS Code restores the panel under after a window reload. */
export const TEST_RUN_DASHBOARD_VIEW_TYPE = "csharpSolutionExplorer.testRunDashboard";

/** What the panel reports back to the dashboard. */
export interface PanelHost {
  handle(message: Incoming): void;
  panelDisposed(): void;
}

export class TestRunDashboardPanel {
  private static current: TestRunDashboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Opens the panel, or brings the existing one forward. An already-open panel keeps whatever column
   * the user dragged it to: a run must not yank the tab back beside the editor every time.
   */
  static createOrShow(context: vscode.ExtensionContext, host: PanelHost, focus: boolean): TestRunDashboardPanel {
    const existing = TestRunDashboardPanel.current;
    if (existing) {
      existing.panel.reveal(undefined, !focus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      TEST_RUN_DASHBOARD_VIEW_TYPE,
      "Test Run",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focus },
      {
        enableScripts: true,
        // Hiding the tab mid-run must not throw away thousands of rendered rows.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    TestRunDashboardPanel.current = new TestRunDashboardPanel(panel, context, host);
    return TestRunDashboardPanel.current;
  }

  /** Takes over the panel VS Code restored after a window reload. There is never a live run then. */
  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, host: PanelHost): TestRunDashboardPanel {
    TestRunDashboardPanel.current?.dispose();
    TestRunDashboardPanel.current = new TestRunDashboardPanel(panel, context, host);
    return TestRunDashboardPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly host: PanelHost,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "solution-explorer-icon.svg");
    this.panel.webview.html = buildPanelHtml({
      webview: this.panel.webview,
      extensionUri: context.extensionUri,
      title: "Test Run",
      styles: ["shared/panel.css", "testRunDashboard/main.css"],
      scripts: ["shared/dom.js", "testRunDashboard/main.js"],
    });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: Incoming) => this.host.handle(message), null, this.disposables);
  }

  post(message: Outgoing): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(focus: boolean): void {
    this.panel.reveal(undefined, !focus);
  }

  dispose(): void {
    if (TestRunDashboardPanel.current === this) {
      TestRunDashboardPanel.current = undefined;
    }
    this.host.panelDisposed();
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

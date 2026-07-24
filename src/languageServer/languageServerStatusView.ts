// The dedicated "C# Language Server" UI: a TreeDataProvider that renders the shared server state as
// live status rows, plus a status-bar item. Both re-render on every state change. Kept intentionally
// simple and data-driven so more rows/sections (or a richer webview) can be added later.

import * as path from "node:path";
import * as vscode from "vscode";
import { ServerPhase, ServerStateStore, ServerStatus } from "./serverState.js";

interface StatusRow {
  label: string;
  value?: string;
  icon?: string;
  tooltip?: string;
}

const PHASE_LABEL: Record<ServerPhase, string> = {
  disabled: "Disabled",
  msExtConflict: "Off — Microsoft C# extension active",
  downloading: "Downloading server…",
  starting: "Starting…",
  running: "Running",
  restarting: "Restarting…",
  stopped: "Stopped",
  failed: "Failed",
};

const PHASE_ICON: Record<ServerPhase, string> = {
  disabled: "circle-slash",
  msExtConflict: "warning",
  downloading: "cloud-download",
  starting: "loading~spin",
  running: "pass-filled",
  restarting: "loading~spin",
  stopped: "primitive-square",
  failed: "error",
};

export class LanguageServerStatusView implements vscode.TreeDataProvider<StatusRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private status: ServerStatus;

  constructor(state: ServerStateStore) {
    this.status = state.status;
    state.onDidChange((s) => {
      this.status = s;
      this.emitter.fire();
    });
  }

  getTreeItem(row: StatusRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    if (row.value !== undefined) {
      item.description = row.value;
    }
    if (row.icon) {
      item.iconPath = new vscode.ThemeIcon(row.icon);
    }
    item.tooltip = row.tooltip ?? (row.value ? `${row.label}: ${row.value}` : row.label);
    return item;
  }

  getChildren(): StatusRow[] {
    return buildRows(this.status);
  }
}

function buildRows(s: ServerStatus): StatusRow[] {
  const rows: StatusRow[] = [{ label: PHASE_LABEL[s.phase], icon: PHASE_ICON[s.phase] }];

  if (s.activity) {
    rows.push({ label: s.activity, icon: "loading~spin" });
  }
  if (s.version) {
    rows.push({ label: "Version", value: s.version, icon: "tag" });
  }
  if (s.rid) {
    rows.push({ label: "Platform", value: s.launch ? `${s.rid} (${s.launch})` : s.rid, icon: "device-desktop" });
  }
  if (s.solution) {
    rows.push({ label: "Solution", value: path.basename(s.solution), icon: "file-code", tooltip: s.solution });
  } else if (s.projects && s.projects.length > 0) {
    rows.push({ label: "Projects", value: String(s.projects.length), icon: "folder-library" });
  }
  if (s.razor) {
    rows.push(
      s.razor.loaded
        ? {
            label: "Razor",
            value: s.razor.version ? `cohosting (${s.razor.version})` : "cohosting",
            icon: "pass-filled",
            tooltip: "Razor cohosting is running inside this server.",
          }
        : {
            label: "Razor",
            value: "highlighting only",
            icon: "info",
            tooltip: s.razor.detail ?? "Razor cohosting is not available.",
          },
    );
  }
  if (s.detail && (s.phase === "failed" || s.phase === "msExtConflict" || s.phase === "disabled")) {
    rows.push({ label: s.detail, icon: s.phase === "failed" ? "error" : "info" });
  }
  return rows;
}

/**
 * A compact status-bar handle that mirrors the server phase. Always visible (even when the server is
 * off) so its action menu — start/stop/restart, logs, cache, settings — is always reachable; clicking
 * opens that QuickPick.
 */
export class LanguageServerStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(state: ServerStateStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = "csharpSolutionExplorer.languageServer.showMenu";
    this.render(state.status);
    state.onDidChange((s) => this.render(s));
  }

  private render(s: ServerStatus): void {
    this.item.text = `$(${PHASE_ICON[s.phase]}) C#`;
    this.item.tooltip = s.activity ? `C# Language Server — ${s.activity}` : `C# Language Server — ${PHASE_LABEL[s.phase]}`;
    // Draw attention only when something is wrong; keep the off/idle states quiet and unstyled.
    this.item.backgroundColor =
      s.phase === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

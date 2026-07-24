// The action menu behind the status-bar item: a native QuickPick that mirrors the current server
// phase and offers the relevant lifecycle/diagnostic actions (start/stop/restart, logs, cache,
// settings). Kept command-driven — every entry just runs an already-registered command — so the menu
// stays a thin, data-driven view over the controller and is easy to extend.

import * as vscode from "vscode";
import { ServerPhase, ServerStateStore, ServerStatus } from "./serverState.js";

interface MenuAction extends vscode.QuickPickItem {
  /** Command id to run on selection; separators/info rows omit it. */
  command?: string;
}

const SEPARATOR: MenuAction = { label: "", kind: vscode.QuickPickItemKind.Separator };

const PHASE_SUMMARY: Record<ServerPhase, string> = {
  disabled: "Disabled",
  msExtConflict: "Off — Microsoft C# extension active",
  downloading: "Downloading…",
  starting: "Starting…",
  running: "Running",
  restarting: "Restarting…",
  stopped: "Stopped",
  failed: "Failed",
};

/** Opens the C# language server action menu, showing only the actions valid for the current phase. */
export async function showLanguageServerMenu(state: ServerStateStore): Promise<void> {
  const status = state.status;
  const pick = await vscode.window.showQuickPick(buildActions(status), {
    title: "C# Language Server",
    placeHolder: describe(status),
  });
  if (pick?.command) {
    await vscode.commands.executeCommand(pick.command);
  }
}

function buildActions(s: ServerStatus): MenuAction[] {
  const actions: MenuAction[] = [];
  // While the server is mid-transition (downloading/starting/restarting) no lifecycle toggle is
  // offered — it would race the in-flight work — leaving only the diagnostic/cache actions below.
  const running = s.phase === "running";
  const off = s.phase === "stopped" || s.phase === "disabled" || s.phase === "failed";

  if (running) {
    actions.push({ label: "$(stop) Stop", detail: "Shut down the server for this session.", command: STOP });
  }
  if (off) {
    actions.push({ label: "$(play) Start", detail: "Start the server.", command: START });
  }
  if (running || off) {
    actions.push({ label: "$(refresh) Restart", detail: "Stop and start the server.", command: RESTART });
  }

  actions.push(
    SEPARATOR,
    { label: "$(output) Show Logs", command: SHOW_LOGS },
    { label: "$(folder) Open Cache Folder", command: OPEN_CACHE },
    { label: "$(trash) Clear Cache & Re-download", command: CLEAR_CACHE },
    SEPARATOR,
    { label: "$(list-tree) Status Details…", command: FOCUS_VIEW },
    { label: "$(gear) Settings…", command: OPEN_SETTINGS },
  );

  return actions;
}

/** A one-line status summary for the QuickPick prompt (phase plus the useful facts we know). */
function describe(s: ServerStatus): string {
  const parts = [s.activity ?? PHASE_SUMMARY[s.phase]];
  if (s.version) {
    parts.push(`v${s.version}`);
  }
  if (s.rid) {
    parts.push(s.launch ? `${s.rid} (${s.launch})` : s.rid);
  }
  if (s.detail && (s.phase === "failed" || s.phase === "msExtConflict" || s.phase === "disabled")) {
    parts.push(s.detail);
  }
  return parts.join(" · ");
}

const RESTART = "csharpSolutionExplorer.languageServer.restart";
const STOP = "csharpSolutionExplorer.languageServer.stop";
const START = "csharpSolutionExplorer.languageServer.start";
const SHOW_LOGS = "csharpSolutionExplorer.languageServer.showLogs";
const OPEN_CACHE = "csharpSolutionExplorer.languageServer.openCacheFolder";
const CLEAR_CACHE = "csharpSolutionExplorer.languageServer.clearCache";
const FOCUS_VIEW = "csharpSolutionExplorer.languageServerView.focus";
const OPEN_SETTINGS = "csharpSolutionExplorer.languageServer.openSettings";

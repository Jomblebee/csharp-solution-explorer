// Shared, observable state for the C# language server. The controller/client push updates here as
// the server is downloaded, started, and does work; the status view and the status-bar item render
// from it. Deliberately UI-agnostic and extensible so later features can add fields without
// touching the consumers.

import * as vscode from "vscode";
import { Rid } from "./rid.js";

export type ServerPhase =
  | "disabled" // turned off via setting
  | "msExtConflict" // ms-dotnettools.csharp present → we intentionally stay off
  | "downloading" // fetching/extracting the server package
  | "starting" // launching the server process / LSP handshake
  | "running" // server is up
  | "restarting"
  | "stopped"
  | "failed";

export interface ServerStatus {
  phase: ServerPhase;
  version?: string;
  rid?: Rid;
  /** How the server was launched, for display. */
  launch?: "native" | "dotnet";
  /** fsPath of the solution opened via `solution/open`, if any. */
  solution?: string;
  /** fsPaths of projects opened via `project/open` when no solution was found. */
  projects?: string[];
  /** Current activity text, e.g. "Restoring…" / "Initializing projects…". */
  activity?: string;
  /** Extra detail or an error message for the failed/conflict phases. */
  detail?: string;
}

/** Small observable store around a single `ServerStatus`. */
export class ServerStateStore {
  private readonly emitter = new vscode.EventEmitter<ServerStatus>();
  readonly onDidChange = this.emitter.event;
  private current: ServerStatus = { phase: "stopped" };

  get status(): ServerStatus {
    return this.current;
  }

  /** Replaces the whole status (use when transitioning to a phase that should clear stale fields). */
  set(status: ServerStatus): void {
    this.current = status;
    this.emitter.fire(this.current);
  }

  /** Merges a partial update into the current status. */
  update(patch: Partial<ServerStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emitter.fire(this.current);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

import * as vscode from "vscode";
import { DebugRid } from "./netcoredbgPackage.js";

export type DebuggerPhase =
  | "idle" // nothing happening yet
  | "disabled" // turned off via setting
  | "unsupportedPlatform" // no published netcoredbg build for this platform
  | "downloading"
  | "ready" // adapter present and usable
  | "building"
  | "debugging"
  | "failed";

export interface DebuggerStatus {
  phase: DebuggerPhase;
  version?: string;
  rid?: DebugRid;
  /** Short progress text, e.g. "Building CSharpSolutionExplorer.Sample.App". */
  activity?: string;
  /** Failure detail, shown to the user. */
  detail?: string;
}

/** Mirrors `ServerStateStore`: `set` replaces the status, `update` merges into it. */
export class DebuggerStateStore {
  private readonly emitter = new vscode.EventEmitter<DebuggerStatus>();
  readonly onDidChange = this.emitter.event;
  private current: DebuggerStatus = { phase: "idle" };

  get status(): DebuggerStatus {
    return this.current;
  }

  /** Replaces the whole status, so fields from a previous phase don't linger. */
  set(status: DebuggerStatus): void {
    this.current = status;
    this.emitter.fire(status);
  }

  update(patch: Partial<DebuggerStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emitter.fire(this.current);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

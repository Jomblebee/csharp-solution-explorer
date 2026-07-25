// Type definitions and constants for the Microsoft.Testing.Platform JSON-RPC server-mode protocol
// (docs: microsoft/testfx docs/mstest-runner-protocol/001-protocol-intro.md). Pure — no vscode, no
// node — so the result-mapping logic that consumes these types stays unit-testable. Only the shapes
// the client actually sends/receives are modeled.

/** Method names on the wire. */
export const MTP_METHODS = {
  initialize: "initialize",
  runTests: "testing/runTests",
  discoverTests: "testing/discoverTests",
  testUpdates: "testing/testUpdates/tests",
  attachDebugger: "client/attachDebugger",
  launchDebugger: "client/launchDebugger",
  log: "client/log",
  exit: "exit",
} as const;

/** Client name reported in `initialize`. */
export const MTP_CLIENT_NAME = "csharp-solution-explorer";

export type ExecutionState =
  | "discovered"
  | "in-progress"
  | "passed"
  | "skipped"
  | "failed"
  | "timed-out"
  | "error"
  | "cancelled";

/**
 * A test node as sent under `testing/testUpdates/tests`. Property names are hyphenated/dotted on the
 * wire (kept verbatim here). `node-type` "action" is a runnable test; "group" is a namespace/class.
 * `.NET` frameworks include `location.type`/`location.method` (class + method) and `location.file`
 * /`location.line-start`.
 */
export interface MtpTestNode {
  uid: string;
  "display-name": string;
  "node-type": "action" | "group";
  "execution-state"?: ExecutionState;
  "time.duration-ms"?: number;
  "error.message"?: string;
  "error.stacktrace"?: string;
  // Per-test console output. Optional on the wire and not sent by every framework — MTP hosts mostly
  // stream their console globally — so the per-test view falls back to nothing rather than breaking.
  "standard-output"?: string;
  "standard-error"?: string;
  "location.file"?: string;
  "location.line-start"?: number;
  "location.type"?: string;
  "location.method"?: string;
  "vstest.TestCase.ManagedType"?: string;
  "vstest.TestCase.ManagedMethod"?: string;
  "vstest.TestCase.FullyQualifiedName"?: string;
}

export interface MtpTestUpdateChange {
  parent?: string;
  node: MtpTestNode;
}

/** Params of a `testing/testUpdates/tests` notification. `changes == null` signals completion. */
export interface MtpTestUpdateParams {
  runId: string;
  changes: MtpTestUpdateChange[] | null;
}

export interface MtpInitializeParams {
  processId: number;
  clientInfo: { name: string; version: string };
  capabilities: { testing: { debuggerProvider: boolean } };
}

export interface MtpAttachDebuggerParams {
  processId: number;
}

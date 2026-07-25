// Maps MTP test nodes to the TrxTestResult shape the controller reports (shared with the TRX path).
// Pure and vscode-free (unit-tested). Two entry points: `mtpNodeToResult` for a single node (used by
// discovery and live streaming), and `mtpNodesToResults` for the whole batch (keeps the last terminal
// state per uid — MTP sends `discovered` → `in-progress` → a terminal state for each test).

import type { MtpTestNode } from "./mtpProtocol.js";
import type { TrxOutcome, TrxTestResult } from "./trxParser.js";

const TERMINAL_STATES = new Set(["passed", "skipped", "failed", "timed-out", "error", "cancelled"]);

export function isActionNode(node: MtpTestNode): boolean {
  return node["node-type"] === "action";
}

export function isTerminalState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

/** Maps one node. For non-terminal states `outcome` is "Other"; callers gate on the state themselves. */
export function mtpNodeToResult(node: MtpTestNode): TrxTestResult {
  return {
    className: classNameOf(node),
    method: methodOf(node),
    outcome: mapOutcome(node["execution-state"]),
    durationMs: roundOrUndefined(node["time.duration-ms"]),
    message: node["error.message"],
    stackTrace: node["error.stacktrace"],
    file: node["location.file"],
    line: node["location.line-start"],
    stdout: consoleOutputOf(node),
  };
}

/** The node's own console output, stdout and stderr joined; undefined when the host sends neither. */
function consoleOutputOf(node: MtpTestNode): string | undefined {
  const parts = [node["standard-output"], node["standard-error"]]
    .map((text) => text?.trim() ?? "")
    .filter((text) => text !== "");
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function mtpNodesToResults(nodes: MtpTestNode[]): TrxTestResult[] {
  // Last update per uid wins.
  const latest = new Map<string, MtpTestNode>();
  for (const node of nodes) {
    latest.set(node.uid, node);
  }

  const results: TrxTestResult[] = [];
  for (const node of latest.values()) {
    if (isActionNode(node) && isTerminalState(node["execution-state"])) {
      results.push(mtpNodeToResult(node));
    }
  }
  return results;
}

function mapOutcome(state: string | undefined): TrxOutcome {
  switch (state) {
    case "passed":
      return "Passed";
    case "failed":
    case "timed-out":
    case "error":
      return "Failed";
    case "skipped":
    case "cancelled":
      return "NotExecuted";
    default:
      return "Other";
  }
}

function classNameOf(node: MtpTestNode): string {
  const explicit = node["location.type"] ?? node["vstest.TestCase.ManagedType"];
  if (explicit) {
    return explicit;
  }
  // Derive from the FQN by dropping the trailing method segment.
  const fqn = node["vstest.TestCase.FullyQualifiedName"];
  if (fqn) {
    const lastDot = fqn.lastIndexOf(".");
    return lastDot >= 0 ? fqn.slice(0, lastDot) : fqn;
  }
  return "(unknown)";
}

function methodOf(node: MtpTestNode): string {
  return node["location.method"] ?? node["vstest.TestCase.ManagedMethod"] ?? node["display-name"];
}

function roundOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" ? Math.round(value) : undefined;
}

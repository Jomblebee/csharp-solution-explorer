// The wire format between the Test Run Dashboard panel and its webview, plus the shapes the run
// pipeline feeds into the tracker. Pure types — no vscode, no runtime code — so both sides of the
// postMessage boundary and the unit tests can share one definition.
//
// There is one update message rather than a "snapshot" and a "delta" pair: `full` says whether the
// webview replaces its activity list or appends to it, which is the only thing that actually differs
// between "here is everything" and "here is what changed".

import type { EtaEstimate } from "./testRunEta.js";

/** Where a project is in its run. `building` covers the MTP host build, which emits no test events. */
export type RunPhase = "pending" | "discovering" | "building" | "running" | "finished";

/** The four states a finished test can land in, matching what `applyResult` reports to VS Code. */
export type DashboardOutcome = "passed" | "failed" | "skipped" | "errored";

/** How a run ended, or that it is still going. */
export type RunState = "running" | "passed" | "failed" | "cancelled";

export interface TestRow {
  /** The `vscode.TestItem` id — also the duration cache key and what "open source" resolves. */
  id: string;
  name: string;
  className: string;
  /** Owning project's item id (its csproj path). */
  project: string;
  outcome: DashboardOutcome;
  durationMs?: number;
  /** Truncated failure text; the run terminal keeps the full message and stack trace. */
  message?: string;
  /** Whether the host can navigate to this test's source. */
  hasSource: boolean;
  /** Change against this test's cached duration, on the "slowest tests" card only. */
  deltaMs?: number;
}

export interface RunningRow {
  id: string;
  name: string;
  project: string;
  startedAt: number;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  /** MTP streams results per test; classic VSTest reports one batch when the run finishes. */
  liveResults: boolean;
  phase: RunPhase;
  /** Tests this project will run, when that can be known up front. */
  known: number | undefined;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  /** Last host output line — the only sign of life a VSTest project gives while it runs. */
  lastLine?: string;
  error?: string;
}

export interface RunHeader {
  runId: number;
  startedAt: number;
  debug: boolean;
  coverage: boolean;
  /** "Running 3 projects" / "Running 12 selected tests" — set once, when the run starts. */
  title: string;
}

export interface DashboardUpdate {
  type: "update";
  /** True = replace the activity list with `finished`; false = append to it. */
  full: boolean;
  header: RunHeader;
  /** The host's clock when this was built, so the webview can tick elapsed/ETA without drifting. */
  serverNow: number;
  state: RunState;
  endedAt?: number;
  total: number | undefined;
  /** A project could not report its count up front — the bar is a floor, not a total. */
  totalIsLowerBound: boolean;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  eta: EtaEstimate;
  projects: ProjectSnapshot[];
  running: RunningRow[];
  /** Finished tests: the delta since the last flush, or the capped history when `full`. */
  finished: TestRow[];
  /** Rows the per-flush cap swallowed, so the webview can say "+N more". */
  finishedDropped: number;
  failures: TestRow[];
  failuresTruncated: boolean;
  /** Slowest tests of this run, descending, with a delta against their cached duration. */
  slowest: TestRow[];
}

export type Outgoing =
  | DashboardUpdate
  /** No run is in flight: a first open, or a panel revived after a window reload. */
  | { type: "idle"; last?: DashboardUpdate; lastEndedAt?: number }
  | { type: "error"; message: string };

export type Incoming =
  | { type: "ready" }
  | { type: "cancelRun" }
  | { type: "rerunFailed" }
  | { type: "rerunAll" }
  | { type: "openTest"; id: string }
  | { type: "openOutput" };

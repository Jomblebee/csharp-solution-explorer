// Aggregates one test run for the dashboard. Pure — no vscode, no timers — because this is where a
// wrong count, a runaway allocation or a nonsense ETA would come from, and all three are cheap to
// unit-test here and expensive to reproduce in a live run.
//
// The tracker instance *is* the run's identity: it travels with the report context through the
// pipeline, so events from projects running concurrently need no run id to be told apart, and nothing
// outlives the run that created it.
//
// Every list it publishes is capped. A run with thousands of tests must cost a bounded amount of
// memory and a bounded message size, so the counts stay exact while the rows degrade to "and N more".

import type {
  DashboardUpdate,
  ProjectSnapshot,
  RunHeader,
  RunPhase,
  RunState,
  RunningRow,
  TestRow,
} from "./dashboardProtocol.js";
import { estimateEta, type EtaEstimate } from "./testRunEta.js";

/** What the run pipeline may call. Deliberately narrow: testItems.ts only ever sees this. */
export interface TestRunSink {
  projectStarted(project: { id: string; name: string; liveResults: boolean; known?: number }): void;
  projectPhase(id: string, phase: RunPhase): void;
  /** The project's test count once discovery has run, with the ids when they are known. */
  projectTotal(id: string, count: number, testIds?: readonly string[]): void;
  projectErrored(id: string, message: string): void;
  projectFinished(id: string, ok: boolean): void;
  testStarted(row: RunningRow): void;
  testFinished(row: TestRow): void;
  output(id: string, line: string): void;
}

/** Finished rows per flush. Beyond this the webview is told how many it did not get. */
const FINISHED_PER_FLUSH = 200;
/** Rows a reopened panel is caught up with. */
const HISTORY_CAP = 300;
const FAILURE_CAP = 500;
const RUNNING_CAP = 50;
const SLOWEST_CAP = 10;
/** Failure text kept per row; the run terminal has the full message and stack trace. */
const MESSAGE_MAX = 400;

export interface TrackerOptions {
  header: RunHeader;
  /** Injected so tests need no timers. */
  now: () => number;
  /** A test's duration in an earlier run, from the persisted cache. */
  predict: (testId: string) => number | undefined;
  /** Fired on every mutation. The dashboard throttles it; the tracker owns no timer. */
  onChange: () => void;
}

export class TestRunTracker implements TestRunSink {
  private readonly projects = new Map<string, ProjectSnapshot>();
  /** Test ids this run expects, as far as discovery could tell. */
  private readonly expected = new Set<string>();
  private readonly finishedIds = new Set<string>();
  private readonly running = new Map<string, RunningRow>();
  /** Finished since the last drain — the delta the webview receives. */
  private pending: TestRow[] = [];
  private pendingDropped = 0;
  private readonly history: TestRow[] = [];
  private readonly failures: TestRow[] = [];
  private failuresTruncated = false;
  private readonly slowest: TestRow[] = [];
  /** Durations seen this run: the median fallback, and what gets written to the cache. */
  private readonly observed: number[] = [];
  private readonly durationsById = new Map<string, number>();
  private lastEta: EtaEstimate | undefined;
  private firstCompletionAt: number | undefined;
  private state: RunState = "running";
  private endedAt: number | undefined;
  private onChange: () => void;

  constructor(private readonly options: TrackerOptions) {
    this.onChange = options.onChange;
  }

  get header(): RunHeader {
    return this.options.header;
  }

  /** Test id → duration, for the persisted cache. Written once, when the run ends. */
  get durations(): ReadonlyMap<string, number> {
    return this.durationsById;
  }

  get isRunning(): boolean {
    return this.state === "running";
  }

  /** Failed and errored rows so far. Read by "Re-run failed". */
  get failedRows(): readonly TestRow[] {
    return this.failures;
  }

  /** Stops this tracker driving the panel. A superseded run still finishes, into nothing. */
  detach(): void {
    this.onChange = (): void => {};
  }

  projectStarted(project: { id: string; name: string; liveResults: boolean; known?: number }): void {
    if (this.ended()) {
      return;
    }
    this.projects.set(project.id, {
      id: project.id,
      name: project.name,
      liveResults: project.liveResults,
      phase: "pending",
      known: project.known,
      completed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errored: 0,
    });
    this.changed();
  }

  projectPhase(id: string, phase: RunPhase): void {
    const project = this.projects.get(id);
    if (this.ended() || !project || project.phase === phase) {
      return;
    }
    project.phase = phase;
    this.changed();
  }

  projectTotal(id: string, count: number, testIds?: readonly string[]): void {
    const project = this.projects.get(id);
    if (this.ended() || !project) {
      return;
    }
    project.known = count;
    for (const testId of testIds ?? []) {
      this.expected.add(testId);
    }
    this.changed();
  }

  projectErrored(id: string, message: string): void {
    const project = this.projects.get(id);
    if (this.ended() || !project) {
      return;
    }
    project.error = truncate(message);
    this.changed();
  }

  projectFinished(id: string, ok: boolean): void {
    const project = this.projects.get(id);
    if (this.ended() || !project) {
      return;
    }
    project.phase = "finished";
    // A project that could not be counted up front is exact once it is over — which is what lets the
    // headline stop reading "≥ N" as the last VSTest project lands.
    project.known = project.completed;
    if (!ok && !project.error) {
      project.error = "The run failed.";
    }
    this.changed();
  }

  testStarted(row: RunningRow): void {
    if (this.ended()) {
      return;
    }
    this.leaveBuilding(row.project);
    this.running.set(row.id, row);
    this.changed();
  }

  testFinished(row: TestRow): void {
    if (this.ended()) {
      return;
    }
    this.leaveBuilding(row.project);
    this.running.delete(row.id);
    const trimmed: TestRow = { ...row, message: truncate(row.message) };
    // A backend that reports the same test twice must not double-count it, or the run would show
    // more completed tests than it has and the bar would run past 100%.
    const project = this.projects.get(row.project);
    if (project && !this.finishedIds.has(row.id)) {
      project.completed++;
      project[row.outcome]++;
    }
    this.finishedIds.add(row.id);
    if (trimmed.durationMs !== undefined) {
      this.observed.push(trimmed.durationMs);
      this.durationsById.set(trimmed.id, trimmed.durationMs);
      this.recordSlowest(trimmed);
    }
    this.firstCompletionAt ??= this.options.now();
    this.pending.push(trimmed);
    this.history.push(trimmed);
    while (this.history.length > HISTORY_CAP) {
      this.history.shift();
    }
    if (trimmed.outcome === "failed" || trimmed.outcome === "errored") {
      if (this.failures.length < FAILURE_CAP) {
        this.failures.push(trimmed);
      } else {
        this.failuresTruncated = true;
      }
    }
    this.changed();
  }

  output(id: string, line: string): void {
    const project = this.projects.get(id);
    if (this.ended() || !project) {
      return;
    }
    const text = line.trim();
    if (!text) {
      return;
    }
    this.leaveBuilding(id);
    project.lastLine = truncate(text, 200);
    this.changed();
  }

  /** Closes the run. The last mutation, so the throttled push still has something to flush. */
  end(cancelled: boolean): void {
    if (this.ended()) {
      return;
    }
    this.state = cancelled ? "cancelled" : this.failed() > 0 ? "failed" : "passed";
    this.endedAt = this.options.now();
    this.running.clear();
    for (const project of this.projects.values()) {
      project.phase = "finished";
    }
    this.changed();
  }

  /** The delta since the last call, plus the always-current counts. Clears the delta. */
  drain(): DashboardUpdate {
    const update = this.build(this.pending, this.pendingDropped, false);
    this.pending = [];
    this.pendingDropped = 0;
    return update;
  }

  /** Everything a freshly opened panel needs to catch up mid-run. */
  snapshot(): DashboardUpdate {
    return this.build(this.history, Math.max(0, this.finishedIds.size - this.history.length), true);
  }

  private build(rows: readonly TestRow[], alreadyDropped: number, full: boolean): DashboardUpdate {
    const projects = [...this.projects.values()];
    const now = this.options.now();
    const completed = sum(projects, (p) => p.completed);
    const knownTotal = sum(projects, (p) => p.known ?? p.completed);
    const totalIsLowerBound = projects.some((p) => p.known === undefined);
    const finished = rows.slice(0, FINISHED_PER_FLUSH);
    const dropped = alreadyDropped + Math.max(0, rows.length - finished.length);

    this.lastEta = estimateEta({
      startedAt: this.options.header.startedAt,
      firstCompletionAt: this.firstCompletionAt,
      now,
      completed,
      // A floor is not a total: extrapolating from it would promise a finish that cannot be kept.
      total: totalIsLowerBound ? undefined : knownTotal,
      observedDurations: this.observed,
      predictedRemaining: this.remainingPredictions(knownTotal, completed),
      activeProjects: projects.filter((p) => p.phase === "running").length,
      previous: this.lastEta,
    });

    return {
      type: "update",
      full,
      header: this.options.header,
      serverNow: now,
      state: this.state,
      endedAt: this.endedAt,
      total: knownTotal,
      totalIsLowerBound,
      completed,
      passed: sum(projects, (p) => p.passed),
      failed: sum(projects, (p) => p.failed),
      skipped: sum(projects, (p) => p.skipped),
      errored: sum(projects, (p) => p.errored),
      eta: this.lastEta,
      projects,
      running: [...this.running.values()].slice(0, RUNNING_CAP),
      finished,
      finishedDropped: dropped,
      failures: this.failures,
      failuresTruncated: this.failuresTruncated,
      slowest: this.slowest,
    };
  }

  /**
   * One entry per test still to run: its cached duration where we know which test it is, and an
   * unknown for every test the count promises but discovery never named.
   */
  private remainingPredictions(total: number, completed: number): (number | undefined)[] {
    const predictions: (number | undefined)[] = [];
    for (const id of this.expected) {
      if (!this.finishedIds.has(id)) {
        predictions.push(this.options.predict(id));
      }
    }
    for (let i = predictions.length; i < total - completed; i++) {
      predictions.push(undefined);
    }
    return predictions;
  }

  /** The first result out of a project means its host has finished building. */
  private leaveBuilding(projectId: string): void {
    const project = this.projects.get(projectId);
    if (project && (project.phase === "building" || project.phase === "pending" || project.phase === "discovering")) {
      project.phase = "running";
    }
  }

  private recordSlowest(row: TestRow): void {
    const cached = this.options.predict(row.id);
    const entry: TestRow = { ...row, deltaMs: cached === undefined ? undefined : (row.durationMs ?? 0) - cached };
    this.slowest.push(entry);
    this.slowest.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
    if (this.slowest.length > SLOWEST_CAP) {
      this.slowest.length = SLOWEST_CAP;
    }
  }

  private failed(): number {
    return sum([...this.projects.values()], (p) => p.failed + p.errored);
  }

  private ended(): boolean {
    return this.state !== "running";
  }

  private changed(): void {
    if (this.pending.length > FINISHED_PER_FLUSH) {
      // Trim as we go: a 5000-test burst between two flushes must not sit in memory in full.
      this.pendingDropped += this.pending.length - FINISHED_PER_FLUSH;
      this.pending = this.pending.slice(-FINISHED_PER_FLUSH);
    }
    this.onChange();
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function truncate(text: string | undefined, max = MESSAGE_MAX): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

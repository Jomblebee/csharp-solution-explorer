// Owns the Test Run Dashboard across runs: the setting, the live tracker, the throttled push to the
// webview, the persisted duration cache and the buttons the webview can press.
//
// It owns the tracker rather than the panel doing so, and that is the whole point: closing the tab
// must not stop a run. When the panel goes away the aggregation carries on, and reopening mid-run
// catches up from `tracker.snapshot()`.

import * as vscode from "vscode";
import { errorText } from "../../shared/errorText.js";
import { throttle } from "../../shared/debounce.js";
import type { DashboardUpdate, Incoming, Outgoing, TestRow } from "./dashboardProtocol.js";
import { mergeRun, predict, readCache, type DurationCacheData } from "./durationCache.js";
import { TestRunDashboardPanel, type PanelHost } from "./testRunDashboardPanel.js";
import { TestRunTracker } from "./testRunTracker.js";

/** How often updates reach the webview. The webview ticks its own clock, so this is generous. */
const UPDATE_INTERVAL_MS = 150;

/** Per-test durations from earlier runs, for the second-run ETA. */
const DURATIONS_KEY = "csharpSolutionExplorer.testDurations";

/** The last finished run, so a panel revived after a reload has something to show. */
const LAST_RUN_KEY = "csharpSolutionExplorer.lastTestRun";

/** Failure rows kept in the persisted summary. The live run keeps far more. */
const PERSISTED_FAILURES = 200;

type DashboardMode = "onRun" | "onFailure" | "off";

/** The run pipeline's side of the dashboard's buttons. Supplied by the test controller. */
export interface DashboardRunner {
  /** Re-runs the given test ids, or everything when they are omitted. */
  rerun(testIds?: readonly string[]): Promise<void>;
  /** Opens a test's source. */
  reveal(testId: string): Promise<void>;
}

export interface BeginRunOptions {
  title: string;
  debug: boolean;
  coverage: boolean;
}

export class TestRunDashboard implements vscode.Disposable, PanelHost {
  private panel: TestRunDashboardPanel | undefined;
  private tracker: TestRunTracker | undefined;
  private runner: DashboardRunner | undefined;
  private cache: DurationCacheData;
  private lastUpdate: DashboardUpdate | undefined;
  private lastEndedAt: number | undefined;
  private runCounter = 0;
  private revealPending = false;
  private readonly push = throttle(() => this.pushUpdate(), UPDATE_INTERVAL_MS);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.cache = readCache(context.workspaceState.get(DURATIONS_KEY));
    const persisted = context.workspaceState.get<{ update: DashboardUpdate; endedAt: number }>(LAST_RUN_KEY);
    this.lastUpdate = persisted?.update;
    this.lastEndedAt = persisted?.endedAt;
  }

  /** Wired by the test controller once its run profiles exist. */
  setRunner(runner: DashboardRunner): void {
    this.runner = runner;
  }

  /** Opens the dashboard because the user asked for it — so it takes focus. */
  show(): void {
    this.panel = TestRunDashboardPanel.createOrShow(this.context, this, true);
    this.postState();
  }

  /** Re-attaches a panel VS Code restored after a window reload. */
  revive(panel: vscode.WebviewPanel): void {
    this.panel = TestRunDashboardPanel.revive(panel, this.context, this);
    this.postState();
  }

  /**
   * Starts tracking a run. Returns undefined when the dashboard is off, which makes every
   * `tracker?.` call in the pipeline free rather than merely cheap.
   */
  beginRun(options: BeginRunOptions): TestRunTracker | undefined {
    const mode = readMode();
    if (mode === "off") {
      return undefined;
    }
    // A previous run may still be draining; it must stop driving the panel, but it is allowed to
    // finish so its durations still reach the cache.
    this.tracker?.detach();
    this.push.cancel();
    this.runCounter++;
    this.tracker = new TestRunTracker({
      header: {
        runId: this.runCounter,
        startedAt: Date.now(),
        debug: options.debug,
        coverage: options.coverage,
        title: options.title,
      },
      now: () => Date.now(),
      predict: (testId) => predict(this.cache, testId),
      onChange: () => this.push(),
    });
    // "onFailure" keeps aggregating but stays out of the way until something actually fails.
    this.revealPending = mode === "onFailure";
    if (mode === "onRun") {
      this.panel = TestRunDashboardPanel.createOrShow(this.context, this, true);
    }
    this.push();
    return this.tracker;
  }

  /** Closes a run: final push, durations into the cache, summary persisted for the next window. */
  async endRun(tracker: TestRunTracker, cancelled: boolean): Promise<void> {
    tracker.end(cancelled);
    if (tracker !== this.tracker) {
      // A superseded run: keep its measurements, do not touch the panel.
      await this.storeDurations(tracker);
      return;
    }
    this.push.flush();
    const summary = tracker.snapshot();
    this.lastUpdate = stripForStorage(summary);
    this.lastEndedAt = summary.endedAt ?? Date.now();
    await this.storeDurations(tracker);
    await this.context.workspaceState.update(LAST_RUN_KEY, {
      update: this.lastUpdate,
      endedAt: this.lastEndedAt,
    });
  }

  handle(message: Incoming): void {
    void this.dispatch(message).catch((err: unknown) => {
      this.panel?.post({ type: "error", message: errorText(err) });
    });
  }

  panelDisposed(): void {
    // The run keeps going; it just has nowhere to post until the panel comes back.
    this.panel = undefined;
  }

  dispose(): void {
    this.push.cancel();
    this.panel?.dispose();
  }

  private async dispatch(message: Incoming): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postState();
        break;
      case "cancelRun":
        // VS Code owns the cancellation token of a run it started, so this goes through its command.
        await vscode.commands.executeCommand("testing.cancelRun");
        break;
      case "rerunFailed": {
        const ids = this.failedIds();
        if (ids.length > 0) {
          await this.runner?.rerun(ids);
        }
        break;
      }
      case "rerunAll":
        await this.runner?.rerun();
        break;
      case "openTest":
        await this.runner?.reveal(message.id);
        break;
      case "openOutput":
        this.output.show(true);
        break;
    }
  }

  private pushUpdate(): void {
    if (!this.tracker) {
      return;
    }
    const update = this.tracker.drain();
    if (this.revealPending && update.failed + update.errored > 0) {
      this.revealPending = false;
      this.panel = TestRunDashboardPanel.createOrShow(this.context, this, true);
      // The delta only makes sense to a panel that saw the rows before it; a panel opening now needs
      // the whole run.
      this.postState();
      return;
    }
    this.panel?.post(update);
  }

  /** What a panel sees the moment it opens: the live run caught up, or the last one. */
  private postState(): void {
    if (!this.panel) {
      return;
    }
    const message: Outgoing = this.tracker
      ? this.tracker.snapshot()
      : { type: "idle", last: this.lastUpdate, lastEndedAt: this.lastEndedAt };
    this.panel.post(message);
  }

  private failedIds(): readonly string[] {
    const rows: readonly TestRow[] = this.tracker?.failedRows ?? this.lastUpdate?.failures ?? [];
    return rows.map((row) => row.id);
  }

  private async storeDurations(tracker: TestRunTracker): Promise<void> {
    if (tracker.durations.size === 0) {
      return;
    }
    this.cache = mergeRun(this.cache, tracker.durations);
    await this.context.workspaceState.update(DURATIONS_KEY, this.cache);
  }
}

function readMode(): DashboardMode {
  const value = vscode.workspace.getConfiguration("csharpSolutionExplorer").get<string>("testExplorer.dashboard");
  return value === "off" || value === "onFailure" ? value : "onRun";
}

/**
 * The summary that survives a window reload. Output and stack traces are dropped deliberately: a
 * Memento is not a log, and a failing run can carry megabytes of them.
 */
function stripForStorage(update: DashboardUpdate): DashboardUpdate {
  return {
    ...update,
    full: true,
    running: [],
    finished: [],
    finishedDropped: 0,
    failures: update.failures.slice(0, PERSISTED_FAILURES),
    failuresTruncated: update.failuresTruncated || update.failures.length > PERSISTED_FAILURES,
    projects: update.projects.map((project) => ({ ...project, lastLine: undefined })),
  };
}

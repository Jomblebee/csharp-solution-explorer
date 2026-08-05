// The native VS Code Test Explorer wiring. Backends are chosen per project:
//   - MTP (Microsoft.Testing.Platform) projects go through the JSON-RPC server protocol (mtpRunner):
//     tests are discovered up front (expand a project), runs can be filtered to a selection, results
//     stream in live, and source locations drive gutter play icons. The only thing that works on the
//     .NET 10 SDK.
//   - Classic VSTest projects use `dotnet test --logger trx` (dotnetTestRunner) + TRX parsing, with
//     single-test runs via `--filter`. No up-front discovery/live (no server) — methods appear after
//     the first run.
// Both backends produce the same TrxTestResult, reported through one shared path (testItems.ts).
//
// A run's log goes to the Test Results panel (curated by outputVerbosity) and, unfiltered, to the
// "C# Tests" output channel. The extension always owns the test process — that is what keeps
// cancellation, the debug attach and MTP's live results working.
//
// This file is the wiring only: the project/discovery state sits in testProjectRegistry.ts, one
// project's actual run in projectTestRun.ts, the panel text in testRunLog.ts, and the mapping from a
// run request to per-project selections in testSelection.ts.

import * as vscode from "vscode";
import { CANCELLED, resolveRunFramework } from "../solutionExplorer/commandUtils.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { CoverageStore } from "./coverageReport.js";
import type { TestRunDashboard } from "./dashboard/testRunDashboard.js";
import { type TestOutputLevel } from "./outputFilter.js";
import { runProjectSelection } from "./projectTestRun.js";
import { TestProjectRegistry } from "./testProjectRegistry.js";
import { discoveredLeafIds, groupIncludesByProject, type Selection } from "./testSelection.js";
import { errorText } from "../shared/errorText.js";

export function createTestController(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  dashboard: TestRunDashboard,
): vscode.TestController {
  const controller = vscode.tests.createTestController("csharpSolutionExplorer.tests", "C# Tests");
  const registry = new TestProjectRegistry(controller, output);

  controller.refreshHandler = () => registry.refresh();
  void registry.refresh();

  // Expanding an MTP project discovers its tests (once, cached until the csproj changes).
  controller.resolveHandler = async (item) => {
    if (!item) {
      return;
    }
    const project = registry.get(item.id);
    if (!project) {
      return;
    }
    const source = new vscode.CancellationTokenSource();
    try {
      await registry.ensureDiscovered(item, project, source.token);
    } finally {
      source.dispose();
    }
  };

  const coverageStore = new CoverageStore();

  const runHandler =
    (debug: boolean, coverage: boolean) =>
    async (request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> => {
      const run = controller.createTestRun(request);
      const entries = [...groupIncludesByProject(controller, request)]
        .map(([projectItem, selection]) => ({ projectItem, selection, project: registry.get(projectItem.id) }))
        .filter((e): e is { projectItem: vscode.TestItem; selection: Selection; project: TargetProject } => !!e.project);
      // The dashboard is opened before anything is resolved, so the first thing the user sees is the
      // run starting rather than a blank tab appearing several seconds in.
      const tracker = dashboard.beginRun({ title: runTitle(entries), debug, coverage });
      try {

        // Serial pre-pass: resolve each project's target framework first. resolveRunFramework may show a
        // QuickPick, and running the projects in parallel would otherwise stack several prompts at once.
        const runnable: { projectItem: vscode.TestItem; selection: Selection; project: TargetProject; framework: string | undefined }[] = [];
        for (const entry of entries) {
          if (token.isCancellationRequested) {
            break;
          }
          const framework = await resolveRunFramework(entry.project.uri, entry.project.name);
          if (framework === CANCELLED) {
            run.skipped(entry.projectItem);
            continue;
          }
          runnable.push({ ...entry, framework });
        }
        for (const entry of runnable) {
          tracker?.projectStarted({
            id: entry.projectItem.id,
            name: entry.project.name,
            liveResults: registry.isMtp(entry.projectItem.id),
          });
        }

        // Coverage needs a per-runner package; offer to add it before running (may abort the run).
        if (coverage && !(await registry.provisionCoverage(runnable))) {
          return; // the `finally` ends the run
        }

        // Each project's discovery + run is independent, so run them concurrently.
        await Promise.all(
          runnable.map(async ({ projectItem, selection, project, framework }) => {
            if (token.isCancellationRequested) {
              return;
            }
            // Cold start: discover the tree before running so live results have items to attach to.
            tracker?.projectPhase(projectItem.id, "discovering");
            await registry.ensureDiscovered(projectItem, project, token);
            const mtp = registry.isMtp(projectItem.id);
            reportPlan(tracker, projectItem, selection, mtp);
            // MTP builds the test host before it reports anything; saying so beats a bar stuck at 0%.
            tracker?.projectPhase(projectItem.id, mtp ? "building" : "running");
            run.started(projectItem);
            try {
              await runProjectSelection(
                {
                  controller,
                  run,
                  tracker,
                  projectItem,
                  project,
                  index: registry.index,
                  selection,
                  framework,
                  debug,
                  coverage,
                  coverageSupported: registry.coverageSupported(projectItem.id),
                  coverageStore,
                  output,
                  level: readOutputLevel(debug),
                  token,
                },
                mtp,
              );
              tracker?.projectFinished(projectItem.id, true);
            } catch (err) {
              run.errored(projectItem, new vscode.TestMessage(errorText(err)));
              tracker?.projectErrored(projectItem.id, errorText(err));
              tracker?.projectFinished(projectItem.id, false);
            }
          }),
        );
        // One FileCoverage per file, after every project has contributed its report.
        coverageStore.publish(run);
      } finally {
        run.end();
        if (tracker) {
          void dashboard.endRun(tracker, token.isCancellationRequested);
        }
      }
    };

  const runTests = runHandler(false, false);
  const runProfile = controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runTests, true);
  controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, runHandler(true, false), true);
  const coverageProfile = controller.createRunProfile(
    "Run with Coverage",
    vscode.TestRunProfileKind.Coverage,
    runHandler(false, true),
    true,
  );
  coverageProfile.loadDetailedCoverage = (run, fileCoverage) => Promise.resolve(coverageStore.detailsFor(run, fileCoverage));

  // The dashboard's buttons run through the same handler a click in the Testing view would, so a
  // re-run from the panel is indistinguishable from any other run.
  dashboard.setRunner({
    rerun: async (testIds) => {
      const include = testIds ? resolveItems(controller, testIds) : undefined;
      if (include && include.length === 0) {
        return;
      }
      const source = new vscode.CancellationTokenSource();
      try {
        await runTests(new vscode.TestRunRequest(include, undefined, runProfile), source.token);
      } finally {
        source.dispose();
      }
    },
    reveal: async (testId) => {
      const item = findItem(controller, testId);
      if (!item?.uri) {
        return;
      }
      const editor = await vscode.window.showTextDocument(item.uri, { preview: true });
      if (item.range) {
        editor.revealRange(item.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.selection = new vscode.Selection(item.range.start, item.range.start);
      }
    },
  });

  context.subscriptions.push(controller, registry);
  return controller;
}

/**
 * Tells the dashboard how many tests a project will run, and which. Only two cases can say so up
 * front: a filtered selection (exact on either backend) and an MTP project whose tree is discovered.
 * A classic VSTest project running everything stays unknown until its TRX arrives — reporting a
 * guess there would turn the progress bar into a lie.
 */
function reportPlan(
  tracker: { projectTotal(id: string, count: number, testIds?: readonly string[]): void } | undefined,
  projectItem: vscode.TestItem,
  selection: Selection,
  mtp: boolean,
): void {
  if (!tracker) {
    return;
  }
  if (selection !== "ALL") {
    const ids = [...selection];
    tracker.projectTotal(projectItem.id, ids.length, ids);
    return;
  }
  if (mtp) {
    const ids = discoveredLeafIds(projectItem);
    tracker.projectTotal(projectItem.id, ids.length, ids);
  }
}

/** The dashboard's headline, fixed when the run starts. */
function runTitle(entries: readonly { selection: Selection }[]): string {
  const selected = entries.reduce((total, entry) => total + (entry.selection === "ALL" ? 0 : entry.selection.size), 0);
  if (selected > 0 && entries.every((entry) => entry.selection !== "ALL")) {
    return `Running ${selected} selected test${selected === 1 ? "" : "s"}`;
  }
  return `Running ${entries.length} project${entries.length === 1 ? "" : "s"}`;
}

/** The items behind a set of ids, skipping any the tree no longer holds (a re-run after a rename). */
function resolveItems(controller: vscode.TestController, ids: readonly string[]): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  for (const id of ids) {
    const item = findItem(controller, id);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function findItem(controller: vscode.TestController, id: string): vscode.TestItem | undefined {
  const search = (collection: vscode.TestItemCollection): vscode.TestItem | undefined => {
    const direct = collection.get(id);
    if (direct) {
      return direct;
    }
    let found: vscode.TestItem | undefined;
    collection.forEach((child) => {
      found ??= search(child.children);
    });
    return found;
  };
  return search(controller.items);
}

/**
 * The configured terminal verbosity. A debug run stays unfiltered: the attach handshake reads the
 * host's "Process Id: N" line, and hiding the surrounding chatter would hide the reason an attach
 * never happened.
 */
function readOutputLevel(debug: boolean): TestOutputLevel {
  if (debug) {
    return "full";
  }
  const configured = vscode.workspace.getConfiguration("csharpSolutionExplorer").get<string>("testExplorer.outputVerbosity");
  return configured === "normal" || configured === "full" ? configured : "summary";
}

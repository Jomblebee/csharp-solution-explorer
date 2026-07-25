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
import { type TestOutputLevel } from "./outputFilter.js";
import { runProjectSelection } from "./projectTestRun.js";
import { TestProjectRegistry } from "./testProjectRegistry.js";
import { groupIncludesByProject, type Selection } from "./testSelection.js";

export function createTestController(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.TestController {
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
      try {
        const entries = [...groupIncludesByProject(controller, request)]
          .map(([projectItem, selection]) => ({ projectItem, selection, project: registry.get(projectItem.id) }))
          .filter((e): e is { projectItem: vscode.TestItem; selection: Selection; project: TargetProject } => !!e.project);

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
            await registry.ensureDiscovered(projectItem, project, token);
            run.started(projectItem);
            try {
              await runProjectSelection(
                {
                  controller,
                  run,
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
                registry.isMtp(projectItem.id),
              );
            } catch (err) {
              run.errored(projectItem, new vscode.TestMessage(errorText(err)));
            }
          }),
        );
        // One FileCoverage per file, after every project has contributed its report.
        coverageStore.publish(run);
      } finally {
        run.end();
      }
    };

  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler(false, false), true);
  controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, runHandler(true, false), true);
  const coverageProfile = controller.createRunProfile(
    "Run with Coverage",
    vscode.TestRunProfileKind.Coverage,
    runHandler(false, true),
    true,
  );
  coverageProfile.loadDetailedCoverage = (run, fileCoverage) => Promise.resolve(coverageStore.detailsFor(run, fileCoverage));

  context.subscriptions.push(controller, registry);
  return controller;
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

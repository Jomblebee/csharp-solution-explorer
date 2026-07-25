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

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { CANCELLED, resolveRunFramework } from "../solutionExplorer/commandUtils.js";
import { buildAttachConfig } from "../debug/debugConfig.js";
import { isUnderExcludedDir } from "../solutionExplorer/diskScanner.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { runTests, type TestRunOutcome } from "./dotnetTestRunner.js";
import { buildFqnFilter } from "./dotnetTestArgs.js";
import { debugTestProject } from "./debugTestRun.js";
import { discoverMtpTests, runMtpTests } from "./mtpRunner.js";
import { isMtpProject } from "./mtpProjectClassifier.js";
import { ensureCoveragePackages } from "./coverageProvisioning.js";
import { findTestProjects } from "./testProjects.js";
import { parseTrx, type TrxOutcome, type TrxTestResult } from "./trxParser.js";
import { TestItemIndex, ensureMethodItem, reportNode, reportResults, type TestReportContext } from "./testItems.js";
import { summarizeHostFailure } from "./hostOutput.js";
import { createLineSplitter, createOutputFilter, toCrlf, type TestOutputLevel } from "./outputFilter.js";
import { debounce, debounceCollect } from "../shared/debounce.js";
import { killTree } from "../shared/killProcess.js";
import { CoverageStore, readCoverageReports } from "./coverageReport.js";

/** Either "run the whole project" or a set of selected method-item ids. */
type Selection = "ALL" | Set<string>;

/** Collapse file-watcher event bursts (a save can fire several) into a single refresh/invalidate. */
const REFRESH_DEBOUNCE_MS = 300;

export function createTestController(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.TestController {
  const controller = vscode.tests.createTestController("csharpSolutionExplorer.tests", "C# Tests");
  const projectsById = new Map<string, TargetProject>();
  const mtpById = new Map<string, boolean>();
  // Project id → whether its restored graph provides the coverage package its runner needs (gates the
  // coverage flags). Filled lazily on the first coverage run, cleared whenever a project file changes.
  const coveragePkgOkById = new Map<string, boolean>();
  const discovered = new Set<string>();
  // Per method item: the raw MTP node and the fully-qualified name a filtered re-run needs.
  const index = new TestItemIndex();

  const refresh = async (): Promise<void> => {
    const projects = await findTestProjects();
    const mtpFlags = await Promise.all(projects.map((p) => readIsMtp(p.uri)));
    projectsById.clear();
    mtpById.clear();
    coveragePkgOkById.clear();
    discovered.clear();
    index.clear();
    const items = projects.map((project, i) => {
      const item = controller.createTestItem(project.uri.fsPath, project.name, project.uri);
      item.canResolveChildren = mtpFlags[i]; // only MTP projects can enumerate tests without a run
      projectsById.set(project.uri.fsPath, project);
      mtpById.set(project.uri.fsPath, mtpFlags[i]);
      return item;
    });
    controller.items.replace(items);
  };

  controller.refreshHandler = refresh;
  void refresh();

  // Discovers an MTP project's tests (once, cached until the csproj changes) and populates the tree.
  // Shared by resolveHandler (project expand) and the run handler, so a cold first run — before the
  // project was ever expanded — still has its test items in place instead of running incompletely.
  const ensureDiscovered = async (
    item: vscode.TestItem,
    project: TargetProject,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    if (!mtpById.get(item.id) || discovered.has(item.id)) {
      return;
    }
    try {
      const nodes = await discoverMtpTests({ project, output, token });
      for (const node of nodes) {
        ensureMethodItem({ controller, projectItem: item, project, index }, node);
      }
      discovered.add(item.id);
    } catch (err) {
      output.appendLine(`Discovery failed for ${project.name}: ${errorText(err)}`);
    }
  };

  // Expanding an MTP project discovers its tests (once, cached until the csproj changes).
  controller.resolveHandler = async (item) => {
    if (!item) {
      return;
    }
    const project = projectsById.get(item.id);
    if (!project) {
      return;
    }
    const source = new vscode.CancellationTokenSource();
    try {
      await ensureDiscovered(item, project, source.token);
    } finally {
      source.dispose();
    }
  };

  // A project added/removed/retargeted changes which test projects exist → full re-discovery.
  const debouncedRefresh = debounce(() => void refresh(), REFRESH_DEBOUNCE_MS);
  const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj}");
  const onProjectEvent = (uri: vscode.Uri): void => {
    if (!isUnderExcludedDir(uri.fsPath)) {
      debouncedRefresh();
    }
  };
  projectWatcher.onDidCreate(onProjectEvent);
  projectWatcher.onDidDelete(onProjectEvent);
  projectWatcher.onDidChange(onProjectEvent);

  // A source edit can add/remove/rename test methods. Rather than reload the whole tree, drop the
  // cached discovery for the owning MTP project so VS Code re-resolves its children on next expand/run.
  const invalidateForFiles = (fileFsPaths: string[]): void => {
    for (const [id, project] of projectsById) {
      if (!mtpById.get(id) || !discovered.has(id)) {
        continue;
      }
      const projectDir = path.dirname(project.uri.fsPath);
      const owned = fileFsPaths.some(
        (fsPath) => fsPath === projectDir || fsPath.startsWith(projectDir + path.sep),
      );
      if (!owned) {
        continue;
      }
      discovered.delete(id);
      index.forgetProject(id);
      const item = controller.items.get(id);
      if (item) {
        item.children.replace([]);
        item.canResolveChildren = true;
      }
    }
  };
  // Collecting rather than debouncing: saving two files at once is two events, and a plain debounce
  // would keep only the last path — leaving the other project on a stale discovery.
  const debouncedInvalidate = debounceCollect(invalidateForFiles, REFRESH_DEBOUNCE_MS);
  const sourceWatcher = vscode.workspace.createFileSystemWatcher("**/*.{cs,fs,vb}");
  // `createFileSystemWatcher` has no exclude argument, so build output has to be dropped here:
  // every build rewrites `obj/**/*.g.cs`, which would throw away the discovery we just built.
  const onSourceEvent = (uri: vscode.Uri): void => {
    if (!isUnderExcludedDir(uri.fsPath)) {
      debouncedInvalidate(uri.fsPath);
    }
  };
  sourceWatcher.onDidCreate(onSourceEvent);
  sourceWatcher.onDidDelete(onSourceEvent);
  sourceWatcher.onDidChange(onSourceEvent);

  const coverageStore = new CoverageStore();

  const runHandler =
    (debug: boolean, coverage: boolean) =>
    async (request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> => {
      const run = controller.createTestRun(request);
      try {
        const entries = [...groupIncludesByProject(controller, request)]
          .map(([projectItem, selection]) => ({ projectItem, selection, project: projectsById.get(projectItem.id) }))
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
        if (coverage && !(await ensureCoveragePackages(runnable, coveragePkgOkById, mtpById))) {
          return; // the `finally` ends the run
        }

        // Each project's discovery + run is independent, so run them concurrently.
        await Promise.all(
          runnable.map(async ({ projectItem, selection, project, framework }) => {
            if (token.isCancellationRequested) {
              return;
            }
            // Cold start: discover the tree before running so live results have items to attach to.
            await ensureDiscovered(projectItem, project, token);
            run.started(projectItem);
            try {
              await runProjectSelection(
                {
                  controller,
                  run,
                  projectItem,
                  project,
                  index,
                  selection,
                  framework,
                  debug,
                  coverage,
                  coverageSupported: coveragePkgOkById.get(projectItem.id) ?? false,
                  coverageStore,
                  output,
                  level: readOutputLevel(debug),
                  token,
                },
                mtpById.get(projectItem.id) ?? false,
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

  context.subscriptions.push(controller, projectWatcher, sourceWatcher);
  return controller;
}

interface RunContext extends TestReportContext {
  selection: Selection;
  /** Target framework resolved up front (undefined = single-target, no `--framework` flag needed). */
  framework: string | undefined;
  debug: boolean;
  coverage: boolean;
  /** Whether this (MTP) project references the coverage extension; false means its `--coverage` flags would abort the run. */
  coverageSupported: boolean;
  coverageStore: CoverageStore;
  output: vscode.OutputChannel;
  /** How much of the host log the run terminal shows; the output channel always gets all of it. */
  level: TestOutputLevel;
  token: vscode.CancellationToken;
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

async function runProjectSelection(ctx: RunContext, mtp: boolean): Promise<void> {
  const { run, project, selection, framework, debug, coverage, coverageSupported, coverageStore, output, level, index, token } = ctx;
  const projectDir = path.dirname(project.uri.fsPath);
  const startedAt = Date.now();
  // One sink per run: its filter collapses repeated blank lines, so it carries state across lines.
  const emit = makeLogSink(run, level);
  // The run's header and summary always show, whatever the verbosity level drops: they delimit one
  // run in a panel several runs share.
  const announce = (text: string): void => writeLine(run, text);
  announce(headerLine(project.name, framework, selection));

  if (mtp) {
    const filter = selection === "ALL" ? undefined : index.nodesFor(selection);
    // The `--coverage*` flags exist only when the CodeCoverage extension is referenced; passing them
    // otherwise aborts the whole run with "Unknown option --coverage". Skip them (and warn) if absent.
    if (coverage && !coverageSupported) {
      const note = `Skipping coverage for ${project.name}: add the 'Microsoft.Testing.Extensions.CodeCoverage' package to collect coverage for this project.`;
      output.appendLine(note);
      writeLine(run, note);
    }
    const coverageDir = coverage && coverageSupported ? await makeResultsDir() : undefined;
    try {
      // The host streams chunks, not lines; buffer them so the filter sees whole lines.
      const splitter = createLineSplitter(emit);
      const outcome = await runMtpTests({
        project,
        framework,
        debug,
        output,
        token,
        filter,
        coverageOutput: coverageDir ? path.join(coverageDir, "coverage.cobertura.xml") : undefined,
        onNode: (node) => reportNode(ctx, node),
        onOutput: (text) => splitter.push(text),
        onAttachDebugger: debug ? makeAttacher(project) : undefined,
      });
      splitter.flush();
      if (coverageDir) {
        coverageStore.add(run, await readCoverageReports(coverageDir), projectDir);
      }
      // Results stream live via onNode; only surface a project-level error when nothing came back.
      if (outcome.results.length === 0) {
        run.errored(ctx.projectItem, new vscode.TestMessage(mtpFailureMessage(outcome.ok, outcome.output)));
      }
      announce(summaryLine(outcome.results, Date.now() - startedAt));
    } finally {
      await removeDir(coverageDir);
    }
    return;
  }

  // Classic VSTest path. Collect coverage only when coverlet.collector is present (otherwise `--collect`
  // runs but writes no report), keeping behaviour consistent with the MTP branch's coverage gate.
  const collectCoverage = coverage && coverageSupported;
  const filter = selection === "ALL" ? undefined : buildFqnFilter(index.fqnsFor(selection));
  const resultsDir = await makeResultsDir();
  try {
    const outcome = debug
      ? await debugTestProject({ project, framework, resultsDir, output, token, filter, onOutput: emit })
      : await runVsTest({ project, framework, resultsDir, output, token, filter, onOutput: emit, coverage: collectCoverage, level });
    if (collectCoverage) {
      coverageStore.add(run, await readCoverageReports(resultsDir), projectDir);
    }
    await reportFromTrx(ctx, outcome, startedAt, announce);
  } finally {
    await removeDir(resultsDir);
  }
}

/** Reports a run whose results arrive in one go through a TRX file: the classic VSTest path. */
async function reportFromTrx(
  ctx: RunContext,
  outcome: TestRunOutcome,
  startedAt: number,
  announce: (text: string) => void,
): Promise<void> {
  let results: TrxTestResult[] = [];
  if (outcome.trxPath) {
    try {
      results = parseTrx(await fs.readFile(outcome.trxPath, "utf8")).results;
    } catch {
      ctx.run.errored(ctx.projectItem, new vscode.TestMessage("Could not read the test results file."));
      return;
    }
  }
  reportResults(ctx, results, outcome.ok, outcome.output);
  announce(summaryLine(results, Date.now() - startedAt));
}

/** Writes one line to the Test Results panel, which needs CRLF endings. */
function writeLine(run: vscode.TestRun, text: string): void {
  run.appendOutput(toCrlf(text) + "\r\n");
}

/**
 * The sink for one line of host output: the Test Results panel gets the curated view, so failures
 * stay clickable there, and `level` decides how much of the rest survives. The full log is in the
 * "C# Tests" output channel either way.
 */
function makeLogSink(run: vscode.TestRun, level: TestOutputLevel): (line: string) => void {
  const filter = createOutputFilter(level);
  return (line: string): void => {
    const kept = filter(line);
    if (kept !== undefined) {
      writeLine(run, kept);
    }
  };
}

function headerLine(name: string, framework: string | undefined, selection: Selection): string {
  const scope = selection === "ALL" ? "all tests" : `${selection.size} selected test${selection.size === 1 ? "" : "s"}`;
  return `▶ ${name}${framework ? ` (${framework})` : ""} — ${scope}`;
}

/** `41 passed, 1 failed, 0 skipped in 3.2s`, counted from the parsed results rather than the log. */
function summaryLine(results: TrxTestResult[], elapsedMs: number): string {
  const count = (outcome: TrxOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${count("Passed")} passed, ${count("Failed")} failed, ${count("NotExecuted")} skipped in ${seconds}s`;
}

/**
 * What to show on a project node when an MTP run produced no results at all. A crashed host is the
 * common case, so lead with the line that names the cause (unknown option, TypeLoadException, …) and
 * point at the full log rather than repeating it — the output channel always has all of it.
 */
function mtpFailureMessage(ok: boolean, output: string): string {
  if (ok) {
    return "No tests were found in this project.";
  }
  const cause = summarizeHostFailure(output);
  return cause
    ? `${cause}\n\nThe test run failed. See the 'C# Tests' output channel for the full log.`
    : "The test run failed. See the 'C# Tests' output channel for the full log.";
}

/** Attaches netcoredbg to the MTP test-host pid when the server requests `client/attachDebugger`. */
function makeAttacher(project: TargetProject): (pid: number, program: string) => Promise<boolean> {
  return (pid, program) =>
    Promise.resolve(
      vscode.debug.startDebugging(folderFor(project), buildAttachConfig(`C#: Debug tests — ${project.name}`, program, pid)),
    );
}

interface RunVsTestOptions {
  project: TargetProject;
  framework: string | undefined;
  resultsDir: string;
  output: vscode.OutputChannel;
  token: vscode.CancellationToken;
  /** VSTest `--filter` expression; omit to run the whole project. */
  filter?: string;
  /** Receives every complete stdout line, for the run terminal. */
  onOutput?: (line: string) => void;
  coverage?: boolean;
  level?: TestOutputLevel;
}

async function runVsTest(opts: RunVsTestOptions): Promise<TestRunOutcome> {
  let killChild: (() => void) | undefined;
  const cancelSub = opts.token.onCancellationRequested(() => killChild?.());
  try {
    return await runTests({
      targetFsPath: opts.project.uri.fsPath,
      resultsDir: opts.resultsDir,
      framework: opts.framework,
      filter: opts.filter,
      coverage: opts.coverage,
      level: opts.level,
      onSpawn: (child) => {
        killChild = () => killTree(child);
      },
      onLine: (line) => {
        opts.output.appendLine(line);
        opts.onOutput?.(line);
      },
    });
  } finally {
    cancelSub.dispose();
  }
}

/** Groups a run request's includes by owning project into "run all" or a selected set of method ids. */
function groupIncludesByProject(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
): Map<vscode.TestItem, Selection> {
  const map = new Map<vscode.TestItem, Selection>();
  if (!request.include) {
    controller.items.forEach((project) => map.set(project, "ALL"));
    return map;
  }
  for (const item of request.include) {
    const project = topAncestor(item);
    if (item === project) {
      map.set(project, "ALL");
      continue;
    }
    const current = map.get(project);
    if (current === "ALL") {
      continue;
    }
    const set = current ?? new Set<string>();
    for (const id of leafIds(item)) {
      set.add(id);
    }
    map.set(project, set);
  }
  return map;
}

/** The method-item ids under an item (itself, if it is already a leaf). */
function leafIds(item: vscode.TestItem): string[] {
  const children: vscode.TestItem[] = [];
  item.children.forEach((c) => children.push(c));
  if (children.length === 0) {
    return [item.id];
  }
  return children.flatMap(leafIds);
}

function topAncestor(item: vscode.TestItem): vscode.TestItem {
  let current = item;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function folderFor(project: TargetProject): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(project.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

/** Whether a project runs on Microsoft.Testing.Platform rather than classic VSTest. */
async function readIsMtp(uri: vscode.Uri): Promise<boolean> {
  try {
    return isMtpProject(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return false;
  }
}

/** A fresh, unique results directory per run (under the OS temp dir); removed by `removeDir`. */
async function makeResultsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cstests-"));
}

/** Drops a results directory once its TRX and coverage reports have been read. Best-effort. */
async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

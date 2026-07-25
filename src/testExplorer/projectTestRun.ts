// Runs one project's selection and reports it, on whichever backend that project uses:
//   - MTP: results stream in live via `onNode`, so the project node only gets an error when nothing
//     came back at all; coverage needs a scratch directory the host writes its Cobertura report to.
//   - Classic VSTest: `dotnet test --logger trx` writes everything at once, parsed and reported after
//     the process exits.
// Both branches end on the same summary line and clean up their results directory.

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { buildAttachConfig } from "../debug/debugConfig.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { killTree } from "../shared/killProcess.js";
import { runTests, type TestRunOutcome } from "./dotnetTestRunner.js";
import { buildFqnFilter } from "./dotnetTestArgs.js";
import { debugTestProject } from "./debugTestRun.js";
import { runMtpTests } from "./mtpRunner.js";
import { CoverageStore, readCoverageReports } from "./coverageReport.js";
import { createLineSplitter, type TestOutputLevel } from "./outputFilter.js";
import { reportNode, reportResults, type TestReportContext } from "./testItems.js";
import { headerLine, makeLogSink, mtpFailureMessage, summaryLine, writeLine } from "./testRunLog.js";
import type { Selection } from "./testSelection.js";
import { parseTrx, type TrxTestResult } from "./trxParser.js";

export interface RunContext extends TestReportContext {
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

export async function runProjectSelection(ctx: RunContext, mtp: boolean): Promise<void> {
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

function folderFor(project: TargetProject): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(project.uri) ?? vscode.workspace.workspaceFolders?.[0];
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

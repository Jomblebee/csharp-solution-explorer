// The native VS Code Test Explorer wiring. Backends are chosen per project:
//   - MTP (Microsoft.Testing.Platform) projects go through the JSON-RPC server protocol (mtpRunner):
//     tests are discovered up front (expand a project), runs can be filtered to a selection, results
//     stream in live, and source locations drive gutter play icons. The only thing that works on the
//     .NET 10 SDK.
//   - Classic VSTest projects use `dotnet test --logger trx` (dotnetTestRunner) + TRX parsing, with
//     single-test runs via `--filter`. No up-front discovery/live (no server) — methods appear after
//     the first run.
// Both backends produce the same TrxTestResult, reported through one shared path.

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { CANCELLED, resolveRunFramework } from "../solutionExplorer/commandUtils.js";
import { buildAttachConfig } from "../debug/debugConfig.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { runTests } from "./dotnetTestRunner.js";
import { buildFqnFilter } from "./dotnetTestArgs.js";
import { debugTestProject } from "./debugTestRun.js";
import { discoverMtpTests, runMtpTests } from "./mtpRunner.js";
import { isMtpProject } from "./mtpProjectClassifier.js";
import { isActionNode, isTerminalState, mtpNodeToResult } from "./mtpResults.js";
import type { MtpTestNode } from "./mtpProtocol.js";
import { findTestProjects } from "./testProjects.js";
import { parseTrx, type TrxTestResult } from "./trxParser.js";
import { classIdFor, groupByClass, methodIdFor } from "./testTree.js";

/** Either "run the whole project" or a set of selected method-item ids. */
type Selection = "ALL" | Set<string>;

export function createTestController(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.TestController {
  const controller = vscode.tests.createTestController("csharpSolutionExplorer.tests", "C# Tests");
  const projectsById = new Map<string, TargetProject>();
  const mtpById = new Map<string, boolean>();
  const discovered = new Set<string>();
  // Method-item id → the raw MTP node it came from (so a filtered run re-sends the exact node).
  const nodeByItemId = new Map<string, MtpTestNode>();
  // Method-item id → fully-qualified name (for VSTest `--filter`).
  const fqnByItemId = new Map<string, string>();

  const refresh = async (): Promise<void> => {
    const projects = await findTestProjects();
    const mtpFlags = await Promise.all(projects.map((p) => isProjectMtp(p.uri)));
    projectsById.clear();
    mtpById.clear();
    discovered.clear();
    nodeByItemId.clear();
    fqnByItemId.clear();
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

  // Expanding an MTP project discovers its tests (once, cached until the csproj changes).
  controller.resolveHandler = async (item) => {
    if (!item) {
      return;
    }
    const project = projectsById.get(item.id);
    if (!project || !mtpById.get(item.id) || discovered.has(item.id)) {
      return;
    }
    try {
      const source = new vscode.CancellationTokenSource();
      const nodes = await discoverMtpTests({ project, output, token: source.token });
      for (const node of nodes) {
        ensureMethodItem(controller, item, project, node, nodeByItemId, fqnByItemId);
      }
      discovered.add(item.id);
    } catch (err) {
      output.appendLine(`Discovery failed for ${project.name}: ${errorText(err)}`);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj}");
  watcher.onDidCreate(() => void refresh());
  watcher.onDidDelete(() => void refresh());
  watcher.onDidChange(() => void refresh());

  const runHandler =
    (debug: boolean) =>
    async (request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> => {
      const run = controller.createTestRun(request);
      try {
        for (const [projectItem, selection] of groupIncludesByProject(controller, request)) {
          if (token.isCancellationRequested) {
            break;
          }
          const project = projectsById.get(projectItem.id);
          if (!project) {
            continue;
          }
          run.started(projectItem);
          try {
            await runProjectSelection(
              { controller, run, projectItem, project, selection, debug, output, token },
              mtpById.get(projectItem.id) ?? false,
              nodeByItemId,
              fqnByItemId,
            );
          } catch (err) {
            run.errored(projectItem, new vscode.TestMessage(errorText(err)));
          }
        }
      } finally {
        run.end();
      }
    };

  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler(false), true);
  controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, runHandler(true), true);

  context.subscriptions.push(controller, watcher);
  return controller;
}

interface RunContext {
  controller: vscode.TestController;
  run: vscode.TestRun;
  projectItem: vscode.TestItem;
  project: TargetProject;
  selection: Selection;
  debug: boolean;
  output: vscode.OutputChannel;
  token: vscode.CancellationToken;
}

async function runProjectSelection(
  ctx: RunContext,
  mtp: boolean,
  nodeByItemId: Map<string, MtpTestNode>,
  fqnByItemId: Map<string, string>,
): Promise<void> {
  const { controller, run, projectItem, project, selection, debug, output, token } = ctx;

  const framework = await resolveRunFramework(project.uri, project.name);
  if (framework === CANCELLED) {
    run.skipped(projectItem);
    return;
  }

  if (mtp) {
    const filter =
      selection === "ALL"
        ? undefined
        : [...selection].map((id) => nodeByItemId.get(id)).filter((n): n is MtpTestNode => n !== undefined);
    const outcome = await runMtpTests({
      project,
      framework,
      debug,
      output,
      token,
      filter,
      onNode: (node) => reportNode(controller, run, projectItem, project, node, nodeByItemId, fqnByItemId),
      onAttachDebugger: debug ? makeAttacher(project) : undefined,
    });
    // Results stream live via onNode; only surface a project-level error when nothing came back.
    if (outcome.results.length === 0) {
      run.errored(projectItem, new vscode.TestMessage(outcome.ok ? "No tests were found in this project." : outcome.output.trim() || "The test run failed."));
    }
    return;
  }

  // Classic VSTest path.
  const filter = selection === "ALL" ? undefined : buildFqnFilter([...selection].map((id) => fqnByItemId.get(id) ?? ""));
  const resultsDir = await makeResultsDir();
  const outcome = debug
    ? await debugTestProject(project, framework, resultsDir, output, token, filter)
    : await runVsTest(project, framework, resultsDir, output, token, filter);

  let results: TrxTestResult[] = [];
  if (outcome.trxPath) {
    try {
      results = parseTrx(await fs.readFile(outcome.trxPath, "utf8")).results;
    } catch {
      run.errored(projectItem, new vscode.TestMessage("Could not read the test results file."));
      return;
    }
  }
  reportResults(controller, run, projectItem, project, results, outcome.ok, outcome.output, fqnByItemId);
}

/** Attaches netcoredbg to the MTP test-host pid when the server requests `client/attachDebugger`. */
function makeAttacher(project: TargetProject): (pid: number, program: string) => Promise<boolean> {
  return (pid, program) =>
    Promise.resolve(
      vscode.debug.startDebugging(folderFor(project), buildAttachConfig(`C#: Debug tests — ${project.name}`, program, pid)),
    );
}

async function runVsTest(
  project: TargetProject,
  framework: string | undefined,
  resultsDir: string,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken,
  filter: string | undefined,
): ReturnType<typeof runTests> {
  let killChild: (() => void) | undefined;
  const cancelSub = token.onCancellationRequested(() => killChild?.());
  try {
    return await runTests({
      targetFsPath: project.uri.fsPath,
      resultsDir,
      framework,
      filter,
      onSpawn: (child) => {
        killChild = () => child.kill();
      },
      onLine: (line) => output.appendLine(line),
    });
  } finally {
    cancelSub.dispose();
  }
}

/** Live per-test reporting for the MTP path: create the item on first sight, then reflect its state. */
function reportNode(
  controller: vscode.TestController,
  run: vscode.TestRun,
  projectItem: vscode.TestItem,
  project: TargetProject,
  node: MtpTestNode,
  nodeByItemId: Map<string, MtpTestNode>,
  fqnByItemId: Map<string, string>,
): void {
  if (!isActionNode(node)) {
    return;
  }
  const { item, result } = ensureMethodItem(controller, projectItem, project, node, nodeByItemId, fqnByItemId);
  const state = node["execution-state"];
  if (state === "in-progress") {
    run.started(item);
  } else if (isTerminalState(state)) {
    applyResult(run, item, result);
  }
}

/** Batch reporting for the VSTest path (results all arrive at once via the TRX). */
function reportResults(
  controller: vscode.TestController,
  run: vscode.TestRun,
  projectItem: vscode.TestItem,
  project: TargetProject,
  results: TrxTestResult[],
  ok: boolean,
  rawOutput: string,
  fqnByItemId: Map<string, string>,
): void {
  if (results.length === 0) {
    const message = ok ? "No tests were found in this project." : rawOutput.trim() || "The test run failed.";
    run.errored(projectItem, new vscode.TestMessage(message));
    return;
  }

  for (const classNode of groupByClass(project.uri.fsPath, results)) {
    const classItem = findOrCreate(controller, projectItem, classNode.id, classNode.className, project.uri);
    for (const methodNode of classNode.methods) {
      const item = findOrCreateMethod(controller, classItem, methodNode.id, methodNode.method, methodNode.result);
      fqnByItemId.set(methodNode.id, `${classNode.className}.${methodNode.method}`);
      applyResult(run, item, methodNode.result);
    }
  }
}

/** Creates (or finds) the class + method items for a node, records its id mappings, returns the method item. */
function ensureMethodItem(
  controller: vscode.TestController,
  projectItem: vscode.TestItem,
  project: TargetProject,
  node: MtpTestNode,
  nodeByItemId: Map<string, MtpTestNode>,
  fqnByItemId: Map<string, string>,
): { item: vscode.TestItem; result: TrxTestResult } {
  const result = mtpNodeToResult(node);
  const classId = classIdFor(project.uri.fsPath, result.className);
  const classItem = findOrCreate(controller, projectItem, classId, result.className, project.uri);
  const methodId = methodIdFor(project.uri.fsPath, result.className, result.method);
  const item = findOrCreateMethod(controller, classItem, methodId, result.method, result);
  nodeByItemId.set(methodId, node);
  fqnByItemId.set(methodId, `${result.className}.${result.method}`);
  return { item, result };
}

function applyResult(run: vscode.TestRun, item: vscode.TestItem, result: TrxTestResult): void {
  switch (result.outcome) {
    case "Passed":
      run.passed(item, result.durationMs);
      break;
    case "Failed": {
      const detail = [result.message, result.stackTrace].filter(Boolean).join("\n\n") || "Test failed.";
      run.failed(item, new vscode.TestMessage(detail), result.durationMs);
      break;
    }
    case "NotExecuted":
      run.skipped(item);
      break;
    default:
      run.errored(item, new vscode.TestMessage(result.message ?? "Test did not run."));
      break;
  }
}

function findOrCreate(
  controller: vscode.TestController,
  parent: vscode.TestItem,
  id: string,
  label: string,
  uri: vscode.Uri,
): vscode.TestItem {
  const existing = parent.children.get(id);
  if (existing) {
    return existing;
  }
  const item = controller.createTestItem(id, label, uri);
  parent.children.add(item);
  return item;
}

/** Like findOrCreate, but points the method item at its source file/line (gutter icons) when known. */
function findOrCreateMethod(
  controller: vscode.TestController,
  classItem: vscode.TestItem,
  id: string,
  label: string,
  result: TrxTestResult,
): vscode.TestItem {
  const existing = classItem.children.get(id);
  if (existing) {
    return existing;
  }
  const uri = result.file ? vscode.Uri.file(result.file) : undefined;
  const item = controller.createTestItem(id, label, uri);
  if (result.file && result.line && result.line > 0) {
    item.range = new vscode.Range(result.line - 1, 0, result.line - 1, 0);
  }
  classItem.children.add(item);
  return item;
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

async function isProjectMtp(uri: vscode.Uri): Promise<boolean> {
  try {
    return isMtpProject(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return false;
  }
}

/** A fresh, unique results directory per VSTest run (under the OS temp dir). */
async function makeResultsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cstests-"));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

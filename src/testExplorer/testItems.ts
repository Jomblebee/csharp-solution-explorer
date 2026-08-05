// Owns the `vscode.TestItem` tree below a project node: creating class/method items with stable ids,
// pointing them at their source line for gutter icons, and reflecting a result onto them. Both
// backends funnel through here, so a test discovered by MTP and the same test reported in a TRX end
// up as one item rather than two.
//
// `TestItemIndex` additionally remembers, per method item, what a filtered re-run needs: the raw MTP
// node (sent back verbatim) and the fully-qualified name (for VSTest's `--filter`).

import * as vscode from "vscode";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import type { MtpTestNode } from "./mtpProtocol.js";
import { isActionNode, isTerminalState, mtpNodeToResult } from "./mtpResults.js";
import type { DashboardOutcome, TestRow } from "./dashboard/dashboardProtocol.js";
import type { TestRunSink } from "./dashboard/testRunTracker.js";
import { classIdFor, groupByClass, methodIdFor } from "./testTree.js";
import type { TrxTestResult } from "./trxParser.js";
import { toCrlf } from "./outputFilter.js";
import { parseStackFrame } from "./stackFrame.js";

/** What the item helpers need to place an item below its project node. */
export interface TestItemContext {
  controller: vscode.TestController;
  projectItem: vscode.TestItem;
  project: TargetProject;
  index: TestItemIndex;
}

/** A context that can also report state, i.e. one belonging to a run rather than to a discovery. */
export interface TestReportContext extends TestItemContext {
  run: vscode.TestRun;
  /**
   * Live aggregator behind the Test Run Dashboard, absent when the dashboard is off. It rides along
   * on the context so events from projects running concurrently need no run id to be told apart —
   * the tracker instance *is* the run.
   */
  tracker?: TestRunSink;
}

/**
 * Per-method-item lookups for re-running a selection. Keyed by item id, which embeds the project
 * path (see `methodIdFor`), so `forgetProject` can drop one project's entries by prefix.
 */
export class TestItemIndex {
  private readonly nodeByItemId = new Map<string, MtpTestNode>();
  private readonly fqnByItemId = new Map<string, string>();

  clear(): void {
    this.nodeByItemId.clear();
    this.fqnByItemId.clear();
  }

  /** Drops everything belonging to one project (its discovery is being invalidated). */
  forgetProject(projectId: string): void {
    const prefix = projectId + "::";
    for (const map of [this.nodeByItemId, this.fqnByItemId]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
        }
      }
    }
  }

  /** The MTP nodes for the selected item ids, skipping ids we never discovered. */
  nodesFor(ids: Iterable<string>): MtpTestNode[] {
    const nodes: MtpTestNode[] = [];
    for (const id of ids) {
      const node = this.nodeByItemId.get(id);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  /** The fully-qualified names for the selected item ids; unknown ids yield `""` (dropped downstream). */
  fqnsFor(ids: Iterable<string>): string[] {
    return [...ids].map((id) => this.fqnByItemId.get(id) ?? "");
  }

  record(methodId: string, fqn: string, node?: MtpTestNode): void {
    this.fqnByItemId.set(methodId, fqn);
    if (node) {
      this.nodeByItemId.set(methodId, node);
    }
  }
}

/** Creates (or finds) the class + method items for an MTP node, records its lookups, returns both. */
export function ensureMethodItem(
  ctx: TestItemContext,
  node: MtpTestNode,
): { item: vscode.TestItem; result: TrxTestResult } {
  const { controller, projectItem, project, index } = ctx;
  const result = mtpNodeToResult(node);
  const classId = classIdFor(project.uri.fsPath, result.className);
  const classItem = findOrCreate(controller, projectItem, classId, result.className, project.uri);
  const methodId = methodIdFor(project.uri.fsPath, result.className, result.method);
  const item = findOrCreateMethod(controller, classItem, methodId, result.method, result);
  index.record(methodId, `${result.className}.${result.method}`, node);
  return { item, result };
}

/** Live per-test reporting for the MTP path: create the item on first sight, then reflect its state. */
export function reportNode(ctx: TestReportContext, node: MtpTestNode): void {
  if (!isActionNode(node)) {
    return;
  }
  const { item, result } = ensureMethodItem(ctx, node);
  const state = node["execution-state"];
  if (state === "in-progress") {
    ctx.run.started(item);
    ctx.tracker?.testStarted({ id: item.id, name: item.label, project: ctx.projectItem.id, startedAt: Date.now() });
  } else if (isTerminalState(state)) {
    applyResult(ctx, item, result);
  }
}

/** Batch reporting for the VSTest path (results all arrive at once via the TRX). */
export function reportResults(ctx: TestReportContext, results: TrxTestResult[], ok: boolean, rawOutput: string): void {
  const { controller, run, projectItem, project, index } = ctx;
  if (results.length === 0) {
    const message = ok ? "No tests were found in this project." : rawOutput.trim() || "The test run failed.";
    run.errored(projectItem, new vscode.TestMessage(message));
    ctx.tracker?.projectErrored(projectItem.id, message);
    return;
  }

  for (const classNode of groupByClass(project.uri.fsPath, results)) {
    const classItem = findOrCreate(controller, projectItem, classNode.id, classNode.className, project.uri);
    for (const methodNode of classNode.methods) {
      const item = findOrCreateMethod(controller, classItem, methodNode.id, methodNode.method, methodNode.result);
      index.record(methodNode.id, `${classNode.className}.${methodNode.method}`);
      applyResult(ctx, item, methodNode.result);
    }
  }
}

function applyResult(ctx: TestReportContext, item: vscode.TestItem, result: TrxTestResult): void {
  const { run } = ctx;
  const frame = parseStackFrame(result.stackTrace);
  const declared = fileLocation(result.file, result.line);
  const fromStack = fileLocation(frame?.file, frame?.line);

  // Attached to the item (third argument), so selecting a test shows only its own output — including
  // for passing tests, where a Console.WriteLine would otherwise be lost in the project-wide log.
  if (result.stdout) {
    run.appendOutput(toCrlf(result.stdout) + "\r\n", declared ?? fromStack, item);
  }

  let outcome: DashboardOutcome;
  switch (result.outcome) {
    case "Passed":
      run.passed(item, result.durationMs);
      outcome = "passed";
      break;
    case "Failed": {
      const detail = [result.message, result.stackTrace].filter(Boolean).join("\n\n") || "Test failed.";
      const message = new vscode.TestMessage(detail);
      // The failing frame beats the test's declared location: it is where the assertion blew up.
      message.location = fromStack ?? declared;
      run.failed(item, message, result.durationMs);
      outcome = "failed";
      break;
    }
    case "NotExecuted":
      run.skipped(item);
      outcome = "skipped";
      break;
    default:
      run.errored(item, new vscode.TestMessage(result.message ?? "Test did not run."));
      outcome = "errored";
      break;
  }
  ctx.tracker?.testFinished(toDashboardRow(ctx, item, result, outcome));
}

/** One finished test, as the dashboard sees it: no vscode types, no stack trace, no output. */
function toDashboardRow(
  ctx: TestReportContext,
  item: vscode.TestItem,
  result: TrxTestResult,
  outcome: DashboardOutcome,
): TestRow {
  return {
    id: item.id,
    name: result.method,
    className: result.className,
    project: ctx.projectItem.id,
    outcome,
    durationMs: result.durationMs,
    message: outcome === "passed" || outcome === "skipped" ? undefined : result.message,
    hasSource: item.uri !== undefined,
  };
}

/** A location at the start of `line` (1-based, as both TRX and stack traces report it). */
function fileLocation(file: string | undefined, line: number | undefined): vscode.Location | undefined {
  if (!file || !line || line <= 0) {
    return undefined;
  }
  return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0));
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

/**
 * Places (and returns) the leaf item for a test method or data-driven case, pointing it at its
 * source file/line for gutter icons. Data-driven cases (`Adds(a: 1)`) are nested under a shared
 * parent method item (`Adds`) so the tree collapses the rows instead of listing them as siblings.
 */
function findOrCreateMethod(
  controller: vscode.TestController,
  classItem: vscode.TestItem,
  id: string,
  label: string,
  result: TrxTestResult,
): vscode.TestItem {
  const base = baseMethodName(label);
  // Non-parameterized methods sit directly under the class; cases sit under a `Adds` group item.
  const parent =
    base === label ? classItem : withRange(findOrCreate(controller, classItem, `${classItem.id}::${base}`, base, uriFor(result, classItem)), result);

  const leaf = withRange(findOrCreate(controller, parent, id, label, uriFor(result, classItem)), result);
  applyTags(leaf, result);
  return leaf;
}

/** Surfaces a result's `[TestCategory]`/`[Trait]` names as filterable tags on the item. */
function applyTags(item: vscode.TestItem, result: TrxTestResult): void {
  if (result.categories && result.categories.length > 0) {
    item.tags = result.categories.map((name) => new vscode.TestTag(name));
  }
}

/**
 * The method name with any data-driven argument suffix removed: `Adds(a: 1)` → `Adds`. The space
 * some runners put before the suffix (`Adds (Todo)`, MSTest's TRX form) goes too, so the group id
 * matches the plain method name a discovery reported — otherwise the tree grows a second, trailing-
 * space copy of the same method next to the discovered one.
 */
function baseMethodName(method: string): string {
  return method.replace(/\s*\(.*\)$/, "");
}

/** The item's source uri (for navigation), falling back to the class file when the result has none. */
function uriFor(result: TrxTestResult, classItem: vscode.TestItem): vscode.Uri {
  return result.file ? vscode.Uri.file(result.file) : (classItem.uri ?? vscode.Uri.file(classItem.id));
}

/** Sets the gutter range on an item when the result carries a source line. Returns the item. */
function withRange(item: vscode.TestItem, result: TrxTestResult): vscode.TestItem {
  if (result.file && result.line && result.line > 0 && !item.range) {
    item.range = new vscode.Range(result.line - 1, 0, result.line - 1, 0);
  }
  return item;
}

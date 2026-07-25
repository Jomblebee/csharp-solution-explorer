// Keeps the Test Explorer's project nodes — and the test items discovered below them — in sync with
// the workspace. One place for the four caches that all age together: which test projects exist,
// which of them run on MTP, which have their coverage package, and which have already been
// discovered. The two file watchers here are exactly what invalidates them, so they live alongside:
// a project file changing means "re-scan everything", a source edit means "this project's discovery
// is stale".
//
// The controller keeps the vscode wiring (handlers, run profiles); this holds the state it consults.

import * as vscode from "vscode";
import * as path from "node:path";
import { isUnderExcludedDir } from "../solutionExplorer/diskScanner.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { debounce, debounceCollect, type Debounced, type DebouncedCollector } from "../shared/debounce.js";
import { ensureCoveragePackages, type CoverageCandidate } from "./coverageProvisioning.js";
import { discoverMtpTests } from "./mtpRunner.js";
import { isMtpProject } from "./mtpProjectClassifier.js";
import { findTestProjects } from "./testProjects.js";
import { TestItemIndex, ensureMethodItem } from "./testItems.js";

/** Collapse file-watcher event bursts (a save can fire several) into a single refresh/invalidate. */
const REFRESH_DEBOUNCE_MS = 300;

export class TestProjectRegistry implements vscode.Disposable {
  private readonly projectsById = new Map<string, TargetProject>();
  private readonly mtpById = new Map<string, boolean>();
  // Project id → whether its restored graph provides the coverage package its runner needs (gates the
  // coverage flags). Filled lazily on the first coverage run, cleared whenever a project file changes.
  private readonly coveragePkgOkById = new Map<string, boolean>();
  private readonly discovered = new Set<string>();
  // Per method item: the raw MTP node and the fully-qualified name a filtered re-run needs.
  readonly index = new TestItemIndex();

  private readonly projectWatcher: vscode.FileSystemWatcher;
  private readonly sourceWatcher: vscode.FileSystemWatcher;
  // Held as fields, not locals: disposing the watchers does not stop a trailing call already in
  // flight, which would then touch the disposed controller. `dispose` cancels both.
  private readonly debouncedRefresh: Debounced<[]>;
  private readonly debouncedInvalidate: DebouncedCollector<string>;

  constructor(
    private readonly controller: vscode.TestController,
    private readonly output: vscode.OutputChannel,
  ) {
    // A project added/removed/retargeted changes which test projects exist → full re-discovery.
    this.debouncedRefresh = debounce(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
    this.projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj}");
    const onProjectEvent = (uri: vscode.Uri): void => {
      if (!isUnderExcludedDir(uri.fsPath)) {
        this.debouncedRefresh();
      }
    };
    this.projectWatcher.onDidCreate(onProjectEvent);
    this.projectWatcher.onDidDelete(onProjectEvent);
    this.projectWatcher.onDidChange(onProjectEvent);

    // Collecting rather than debouncing: saving two files at once is two events, and a plain debounce
    // would keep only the last path — leaving the other project on a stale discovery.
    this.debouncedInvalidate = debounceCollect(
      (paths: string[]) => this.invalidateForFiles(paths),
      REFRESH_DEBOUNCE_MS,
    );
    this.sourceWatcher = vscode.workspace.createFileSystemWatcher("**/*.{cs,fs,vb}");
    // `createFileSystemWatcher` has no exclude argument, so build output has to be dropped here:
    // every build rewrites `obj/**/*.g.cs`, which would throw away the discovery we just built.
    const onSourceEvent = (uri: vscode.Uri): void => {
      if (!isUnderExcludedDir(uri.fsPath)) {
        this.debouncedInvalidate(uri.fsPath);
      }
    };
    this.sourceWatcher.onDidCreate(onSourceEvent);
    this.sourceWatcher.onDidDelete(onSourceEvent);
    this.sourceWatcher.onDidChange(onSourceEvent);
  }

  /** Re-scans the workspace for test projects and replaces the controller's top-level items. */
  async refresh(): Promise<void> {
    const projects = await findTestProjects();
    const mtpFlags = await Promise.all(projects.map((p) => readIsMtp(p.uri)));
    this.projectsById.clear();
    this.mtpById.clear();
    this.coveragePkgOkById.clear();
    this.discovered.clear();
    this.index.clear();
    const items = projects.map((project, i) => {
      const item = this.controller.createTestItem(project.uri.fsPath, project.name, project.uri);
      item.canResolveChildren = mtpFlags[i]; // only MTP projects can enumerate tests without a run
      this.projectsById.set(project.uri.fsPath, project);
      this.mtpById.set(project.uri.fsPath, mtpFlags[i]);
      return item;
    });
    this.controller.items.replace(items);
  }

  get(id: string): TargetProject | undefined {
    return this.projectsById.get(id);
  }

  isMtp(id: string): boolean {
    return this.mtpById.get(id) ?? false;
  }

  /** Whether the project's runner can collect coverage; only meaningful after `provisionCoverage`. */
  coverageSupported(id: string): boolean {
    return this.coveragePkgOkById.get(id) ?? false;
  }

  /**
   * Resolves (and, on the user's say-so, installs) the coverage package for the projects about to
   * run, caching the outcome per project. Returns whether the run should proceed.
   */
  provisionCoverage(runnable: CoverageCandidate[]): Promise<boolean> {
    return ensureCoveragePackages(runnable, this.coveragePkgOkById, this.mtpById);
  }

  /**
   * Discovers an MTP project's tests (once, cached until the csproj changes) and populates the tree.
   * Shared by resolveHandler (project expand) and the run handler, so a cold first run — before the
   * project was ever expanded — still has its test items in place instead of running incompletely.
   */
  async ensureDiscovered(item: vscode.TestItem, project: TargetProject, token: vscode.CancellationToken): Promise<void> {
    if (!this.isMtp(item.id) || this.discovered.has(item.id)) {
      return;
    }
    try {
      const nodes = await discoverMtpTests({ project, output: this.output, token });
      for (const node of nodes) {
        ensureMethodItem({ controller: this.controller, projectItem: item, project, index: this.index }, node);
      }
      this.discovered.add(item.id);
    } catch (err) {
      this.output.appendLine(`Discovery failed for ${project.name}: ${errorText(err)}`);
    }
  }

  /**
   * A source edit can add/remove/rename test methods. Rather than reload the whole tree, drop the
   * cached discovery for the owning MTP project so VS Code re-resolves its children on next expand/run.
   */
  private invalidateForFiles(fileFsPaths: string[]): void {
    for (const [id, project] of this.projectsById) {
      if (!this.isMtp(id) || !this.discovered.has(id)) {
        continue;
      }
      const projectDir = path.dirname(project.uri.fsPath);
      const owned = fileFsPaths.some(
        (fsPath) => fsPath === projectDir || fsPath.startsWith(projectDir + path.sep),
      );
      if (!owned) {
        continue;
      }
      this.discovered.delete(id);
      this.index.forgetProject(id);
      const item = this.controller.items.get(id);
      if (item) {
        item.children.replace([]);
        item.canResolveChildren = true;
      }
    }
  }

  dispose(): void {
    // Cancel before disposing: an event from the last 300 ms still has its trailing call armed, and
    // it would run against a controller that is already gone.
    this.debouncedRefresh.cancel();
    this.debouncedInvalidate.cancel();
    this.projectWatcher.dispose();
    this.sourceWatcher.dispose();
  }
}

/** Whether a project runs on Microsoft.Testing.Platform rather than classic VSTest. */
async function readIsMtp(uri: vscode.Uri): Promise<boolean> {
  try {
    return isMtpProject(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

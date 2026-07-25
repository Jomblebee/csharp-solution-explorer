// The NuGet manager webview: a single editor-area panel (Visual Studio's "Manage Packages for
// Solution" in spirit) with Browse / Installed / Updates tabs and a solution-wide project checklist.
// This module owns the panel lifecycle, the HTML shell (CSP + nonce, assets from media/nugetManager),
// and the message bridge to nugetManagerService. All README markdown is rendered to HTML here — in the
// tested, sanitizing renderer — so the webview only ever injects vetted markup.

import * as vscode from "vscode";
import { SolutionTreeDataProvider } from "../solutionExplorer/tree/solutionTreeDataProvider.js";
import { errorMessage } from "../solutionExplorer/commandUtils.js";
import { searchPackages } from "./nugetApi.js";
import { renderMarkdown } from "./markdown.js";
import {
  aggregateInstalled,
  computeConsolidation,
  ProjectRef,
  projectsBelowVersion,
  projectsNotAtVersion,
  projectsWithPackage,
} from "./installedView.js";
import {
  ApplyProgress,
  applyPackage,
  applyUpdates,
  getPackageDetails,
  getSolutionState,
  getUpdates,
  SolutionState,
} from "./nugetManagerService.js";

type Incoming =
  | { type: "ready" }
  // `requestId` is echoed back untouched so the webview can drop a response that a newer request
  // has already superseded (rapid version switches, or the prerelease toggle re-running a query).
  | { type: "search"; query: string; prerelease: boolean; requestId?: number }
  | { type: "getDetails"; id: string; version?: string; requestId?: number }
  | { type: "getUpdates" }
  | { type: "refresh" }
  // The webview names projects only by path and never resolves *which* projects an operation moves —
  // that is decided here against the freshly-read state, so a stale webview cannot act on versions
  // it compared itself (and cannot compare them as strings, which it has no version parser for).
  | { type: "apply"; op: "install" | "update" | "uninstall"; id: string; version?: string; projectFsPaths: string[] }
  | { type: "applyUpdates"; entries: { id: string; version: string }[] }
  | { type: "consolidate"; id: string; version: string }
  | { type: "openExternal"; url: string };

/** The view type VS Code restores the panel under after a window reload. */
export const NUGET_MANAGER_VIEW_TYPE = "csharpSolutionExplorer.nugetManager";

/** What the panel persists so a restored instance knows which solution it was managing. */
interface PersistedState {
  solutionFsPath?: string;
  preselectFsPath?: string;
}

export class NugetManagerPanel {
  private static current: NugetManagerPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private state: SolutionState | undefined;

  /**
   * Rebuilds the panel VS Code restored after a window reload. The restored webview is blank, so the
   * solution has to come back from the persisted state; if that solution no longer exists (renamed,
   * deleted, different folder opened) the panel is closed rather than left showing nothing.
   */
  static async revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    provider: SolutionTreeDataProvider,
    persisted: PersistedState | undefined,
  ): Promise<void> {
    const solutionFsPath = persisted?.solutionFsPath;
    if (!solutionFsPath) {
      panel.dispose();
      return;
    }
    const solutionUri = vscode.Uri.file(solutionFsPath);
    try {
      await vscode.workspace.fs.stat(solutionUri);
    } catch {
      panel.dispose();
      return;
    }
    NugetManagerPanel.current?.dispose(); // never leave two panels bound to the same singleton
    NugetManagerPanel.current = new NugetManagerPanel(
      panel,
      context,
      provider,
      solutionUri,
      persisted.preselectFsPath,
    );
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    provider: SolutionTreeDataProvider,
    solutionUri: vscode.Uri,
    preselectFsPath?: string,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (NugetManagerPanel.current) {
      NugetManagerPanel.current.solutionUri = solutionUri;
      NugetManagerPanel.current.preselectFsPath = preselectFsPath;
      NugetManagerPanel.current.panel.reveal(column);
      void NugetManagerPanel.current.sendSolutionState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      NUGET_MANAGER_VIEW_TYPE,
      "NuGet: Package Manager",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    NugetManagerPanel.current = new NugetManagerPanel(panel, context, provider, solutionUri, preselectFsPath);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly provider: SolutionTreeDataProvider,
    private solutionUri: vscode.Uri,
    private preselectFsPath: string | undefined,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "solution-explorer-icon.svg");
    this.panel.webview.html = this.buildHtml(context.extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: Incoming) => void this.handle(msg), null, this.disposables);
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(msg: Incoming): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.sendSolutionState();
          break;
        case "search": {
          const results = await searchPackages(msg.query, { prerelease: msg.prerelease });
          this.post({ type: "searchResults", query: msg.query, results, requestId: msg.requestId });
          break;
        }
        case "getDetails": {
          const details = await getPackageDetails(msg.id, msg.version);
          this.post({
            type: "details",
            id: msg.id,
            requestId: msg.requestId,
            metadata: details.metadata,
            versions: details.versions,
            readmeHtml: details.readme ? renderMarkdown(details.readme) : undefined,
          });
          break;
        }
        case "refresh": {
          // Re-read the solution from disk (a `dotnet` run outside the panel, a hand-edited .csproj)
          // and re-query nuget.org for updates, so the badge and the Updates tab are current.
          const state = await this.refreshState();
          this.post(this.stateMessage({ type: "solutionState" }));
          const updates = await getUpdates(state);
          this.post({ type: "updates", updates });
          break;
        }
        case "getUpdates": {
          if (this.state) {
            const updates = await getUpdates(this.state);
            this.post({ type: "updates", updates });
          }
          break;
        }
        case "apply": {
          if (this.rejectIfCentrallyManaged()) {
            break;
          }
          const op = msg.op;
          const projects = this.resolveProjects(msg.projectFsPaths, op === "uninstall" ? msg.id : undefined);
          const title = op === "uninstall" ? `Removing ${msg.id}` : `Installing ${msg.id}`;
          const results = await this.withProgress(title, op, (report, token) =>
            applyPackage(op, msg.id, msg.version, projects, report, token),
          );
          this.provider.refresh();
          await this.refreshState();
          this.post(this.stateMessage({ type: "applyResult", op, id: msg.id, results }));
          break;
        }
        case "applyUpdates": {
          // An update only ever moves a project *up*, so the target set is the projects strictly
          // below the new version.
          await this.runBatch(
            msg.entries.map((entry) => ({
              id: entry.id,
              version: entry.version,
              projects: projectsBelowVersion(this.state?.projects ?? [], entry.id, entry.version),
            })),
            "Updating NuGet packages",
          );
          break;
        }
        case "consolidate": {
          // Consolidating deliberately moves projects that are *ahead* of the target back down to it —
          // that is the whole point — so the target set is every project not already on it.
          await this.runBatch(
            [
              {
                id: msg.id,
                version: msg.version,
                projects: projectsNotAtVersion(this.state?.projects ?? [], msg.id, msg.version),
              },
            ],
            `Consolidating ${msg.id}`,
          );
          break;
        }
        case "openExternal":
          if (/^https?:\/\//i.test(msg.url)) {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  /**
   * Turns the project paths the webview checked into the project records an operation needs, in
   * solution order. When `mustHavePackage` is given (uninstall) projects that do not reference it are
   * dropped — removing a package a project never had would just fail noisily.
   */
  private resolveProjects(fsPaths: string[], mustHavePackage?: string): ProjectRef[] {
    const wanted = new Set(fsPaths);
    const projects = (this.state?.projects ?? []).filter((project) => wanted.has(project.fsPath));
    if (!mustHavePackage) {
      return projects.map((project) => ({ name: project.name, fsPath: project.fsPath }));
    }
    const holding = new Set(projectsWithPackage(projects, mustHavePackage).map((project) => project.fsPath));
    return projects
      .filter((project) => holding.has(project.fsPath))
      .map((project) => ({ name: project.name, fsPath: project.fsPath }));
  }

  /**
   * Runs a batch of package moves (Update all, Update one, Consolidate) and reports it back. Entries
   * that resolved to no projects are dropped; if nothing is left there is nothing to run, and the
   * webview is told so — it can no longer work that out itself now that resolution happens here.
   */
  private async runBatch(
    entries: { id: string; version: string; projects: ProjectRef[] }[],
    title: string,
  ): Promise<void> {
    if (this.rejectIfCentrallyManaged()) {
      return;
    }
    const actionable = entries.filter((entry) => entry.projects.length > 0);
    if (actionable.length === 0) {
      this.post(this.stateMessage({ type: "batchResult", entries: [], message: "Nothing to update." }));
      return;
    }
    const results = await this.withProgress(title, "update", (report, token) =>
      applyUpdates(actionable, report, token),
    );
    this.provider.refresh();
    await this.refreshState();
    this.post(this.stateMessage({ type: "batchResult", entries: results }));
  }

  /**
   * Attaches the current solution state and everything derived from it to an outgoing message. The
   * derived lists are computed here rather than in the webview so they are type-checked and tested;
   * routing them through one helper keeps the several call sites from drifting apart.
   */
  private stateMessage(extra: Record<string, unknown>): Record<string, unknown> {
    const projects = this.state?.projects ?? [];
    return {
      ...extra,
      state: this.state,
      installed: aggregateInstalled(projects),
      consolidate: computeConsolidation(projects),
    };
  }

  /**
   * Runs a package operation inside a cancellable VS Code notification (bottom-right) while also
   * streaming each step to the webview as an `applyProgress` message, so the panel can show its own
   * busy state. The `report` handed to `run` drives both surfaces from one place.
   */
  private withProgress<T>(
    title: string,
    op: "install" | "update" | "uninstall",
    run: (report: (progress: ApplyProgress) => void, token: vscode.CancellationToken) => Promise<T>,
  ): Thenable<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        const report = (p: ApplyProgress): void => {
          progress.report({ increment: 100 / p.total, message: `${p.id} (${p.done}/${p.total})` });
          this.post({ type: "applyProgress", op, done: p.done, total: p.total, id: p.id });
        };
        return run(report, token);
      },
    );
  }

  /**
   * Refuses a write when the solution manages versions centrally. The webview already disables the
   * buttons, but the check belongs here too: the panel must not act on a message that arrives from a
   * stale webview state (e.g. the props file appeared while the panel was open).
   */
  private rejectIfCentrallyManaged(): boolean {
    if (!this.state?.centralPackageManagement) {
      return false;
    }
    this.post({
      type: "error",
      message:
        "This solution uses Central Package Management, so versions are set in Directory.Packages.props. " +
        "Edit that file instead — changing a project would put a version where MSBuild does not expect one.",
    });
    return true;
  }

  private async refreshState(): Promise<SolutionState> {
    this.state = await getSolutionState(this.solutionUri);
    return this.state;
  }

  private async sendSolutionState(): Promise<void> {
    await this.refreshState();
    // `solutionFsPath` is what the webview persists via `setState`, so a panel restored after a
    // window reload can tell `revive` which solution it belongs to.
    this.post(
      this.stateMessage({
        type: "solutionState",
        preselectFsPath: this.preselectFsPath,
        solutionFsPath: this.solutionUri.fsPath,
      }),
    );
  }

  private buildHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const asset = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "nugetManager", file));
    // Images may come from arbitrary hosts (package icons on GitHub avatars/CDNs, README images), so
    // img-src is broad for https; scripts/styles are locked to our nonce + the webview origin.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${asset("main.css")}" nonce="${nonce}" />
  <title>NuGet Package Manager</title>
</head>
<body>
  <div id="app" aria-busy="true"></div>
  <script nonce="${nonce}">
    // Safety net: if main.js fails to parse or throws while initialising, the whole script never
    // runs — so its own error handler can't fire and the panel would just sit blank. This inline
    // boundary runs first and catches those top-level failures, surfacing them in the panel.
    window.addEventListener("error", function (event) {
      var app = document.getElementById("app");
      if (!app) return;
      app.removeAttribute("aria-busy");
      app.textContent = "The NuGet Package Manager failed to load: " +
        ((event && event.message) || "unknown error") + ". Please reload the window.";
    });
  </script>
  <script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    NugetManagerPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

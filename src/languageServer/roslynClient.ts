// Wires the vscode-languageclient to the Roslyn server: builds the client, performs the
// non-standard "open workspace" handshake, and handles the server's request to restore projects so
// external (NuGet) references resolve. The file discovery reuses the same globs the tree uses.

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { WorkspaceEdit as LspWorkspaceEdit } from "vscode-languageclient";
import {
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
} from "vscode-languageclient/node";
import { restore } from "../solutionExplorer/dotnetCli.js";
import { ResolvedServer } from "./roslynDownloader.js";
import { registerAttachDebuggerHandler, registerRunTestsCommand } from "./runTests.js";
import { decideHandshake, LoadMode } from "./roslynHandshake.js";
import { buildServerLaunch, RazorLaunch } from "./roslynServer.js";
import { ServerStateStore } from "./serverState.js";

const EXCLUDE_GLOB = "**/{node_modules,bin,obj,.git,.vs}/**";

/**
 * Builds the LSP client for the Roslyn server. When `razor` is supplied, the server is launched with
 * the Razor cohost extension so it handles `.razor`/`.cshtml` itself (Stufe 2); otherwise the client
 * is C#-only.
 *
 * The static `documentSelector` is ALWAYS `csharp`-only — even with Razor cohosting. In cohosting the
 * server registers the Razor document capabilities (hover, references CodeLens, definition, …)
 * *dynamically* via `client/registerCapability` for `.razor`/`.cshtml`. Adding `aspnetcorerazor` to
 * the static selector too registers a second set of providers on top of those, so every Razor feature
 * runs twice (duplicate CodeLens/hover). This matches dotnet/vscode-csharp, whose Roslyn client
 * selector is `['csharp']` regardless of cohosting.
 */
export function createLanguageClient(
  server: ResolvedServer,
  logLevel: string,
  logDir: string,
  outputChannel: vscode.LogOutputChannel,
  razor?: RazorLaunch,
): LanguageClient {
  const launch = buildServerLaunch(server, logLevel, logDir, razor);
  const executable = { command: launch.command, args: launch.args };
  const serverOptions: ServerOptions = { run: executable, debug: executable };
  const documentSelector = [{ language: "csharp" }];
  const clientOptions: LanguageClientOptions = {
    documentSelector,
    outputChannel,
    progressOnInitialization: true,
    // vscode-languageclient pops window.showErrorMessage for every failed LSP request by default
    // (e.g. Roslyn's known textDocument/diagnostic failure on Razor source-generated docs). Genuine
    // failures already get explicit showErrorMessage calls in languageServerController.ts, so this
    // just silences framework noise while still logging to the output channel.
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    middleware: {
      // Roslyn pulls its options via workspace/configuration using editorconfig-style section names.
      // We answer only the background-analysis scope keys (from our diagnosticsScope setting) and let
      // everything else fall through to the server's own defaults by returning null.
      workspace: {
        configuration: (params) => params.items.map((item) => resolveServerConfig(item.section)),
      },
    },
  };
  return new LanguageClient(
    "csharpSolutionExplorer.languageServer",
    "C# Language Server",
    serverOptions,
    clientOptions,
  );
}

/**
 * The two Roslyn option names (editorconfig-style, without the `csharp|`/`visual_basic|` language
 * prefix) that carry the background-analysis scope for analyzer and compiler diagnostics. Both are
 * driven from our single `diagnosticsScope` setting.
 */
const DIAGNOSTICS_SCOPE_OPTIONS = new Set([
  "background_analysis.dotnet_analyzer_diagnostics_scope",
  "background_analysis.dotnet_compiler_diagnostics_scope",
]);

/**
 * Answers one Roslyn `workspace/configuration` item. Returns the configured background-analysis scope
 * for the analyzer/compiler diagnostics options (C# or unprefixed only), and `null` for everything
 * else so the server keeps its own default. Values (`openFiles` | `fullSolution` | `none`) are what
 * Roslyn expects verbatim.
 */
function resolveServerConfig(section: string | undefined): string | null {
  if (!section) {
    return null;
  }
  const pipe = section.indexOf("|");
  if (pipe >= 0) {
    // Language-scoped option: only honour C# (VB/other languages fall through to defaults).
    if (section.slice(0, pipe) !== "csharp") {
      return null;
    }
    section = section.slice(pipe + 1);
  }
  if (!DIAGNOSTICS_SCOPE_OPTIONS.has(section)) {
    return null;
  }
  return vscode.workspace
    .getConfiguration("csharpSolutionExplorer.languageServer")
    .get<string>("diagnosticsScope", "openFiles");
}

/**
 * Registers the client-side commands the Roslyn server points its CodeLens / completion / code-action
 * items at. These are global commands (not tied to a client instance), so register once for the
 * extension's lifetime — NOT per client start, or the second `registerCommand` throws "command already
 * exists". Commands that need to talk to the server pull the *current* client via `getClient` (it is
 * recreated on every restart), so they keep working across restarts and no-op when nothing is running.
 *
 * - `roslyn.client.peekReferences` is what the "N references" CodeLens above a member invokes.
 * - `roslyn.client.nestedCodeAction` backs grouped quick-fixes such as "Suppress or configure issues";
 *   without it VS Code shows "command 'roslyn.client.nestedCodeAction' not found" when the group is
 *   picked. It shows the sub-actions as a QuickPick, then resolves + applies the chosen one.
 * - `roslyn.client.fixAllCodeAction` backs "Fix all occurrences" (also reachable from a nested action).
 * - `dotnet.test.run` backs both the "Run Test" and "Debug Test" CodeLens (see `runTests.ts`).
 *
 * Without a command VS Code shows "command '<id>' not found" on click. Ported (MIT) from vscode-csharp
 * (`serverCommands.ts`, `diagnostics/nestedCodeAction.ts`, `diagnostics/fixAllCodeAction.ts`). Arguments
 * come straight from the server as JSON, so they are plain objects (no vscode prototypes).
 */
export function registerServerCommands(
  getClient: () => LanguageClient | undefined,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      "roslyn.client.peekReferences",
      async (uriStr: string, position: { line: number; character: number }) => {
        const uri = vscode.Uri.parse(uriStr, true);
        const at = new vscode.Position(position.line, position.character);
        const references = await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          uri,
          at,
        );
        if (Array.isArray(references)) {
          // Resilient to the document having moved on since the CodeLens was computed.
          await vscode.commands.executeCommand("editor.action.showReferences", uri, at, references);
        }
      },
    ),
    vscode.commands.registerCommand("roslyn.client.nestedCodeAction", (data: unknown) =>
      runNestedCodeAction(getClient(), data, output),
    ),
    vscode.commands.registerCommand("roslyn.client.fixAllCodeAction", (data: unknown) =>
      runFixAllCodeAction(getClient(), data as FixAllData, output),
    ),
    registerRunTestsCommand(getClient),
  );
}

/** The Roslyn-specific `data` blob riding on a code action; only the fields we consume are typed. */
interface FixAllData {
  UniqueIdentifier: string;
  FixAllFlavors?: string[];
}

interface NestedAction {
  title: string;
  data: FixAllData & { CodeActionPath?: string[] };
}

/** LSP `codeAction/resolve`; Roslyn's non-standard fix-all resolve. */
const CODE_ACTION_RESOLVE = "codeAction/resolve";
const CODE_ACTION_RESOLVE_FIX_ALL = "codeAction/resolveFixAll";

/**
 * Handles a "nested" code action group (e.g. "Suppress or configure issues"): lists the sub-actions in
 * a QuickPick, then resolves the chosen one to a WorkspaceEdit and applies it. A sub-action that is
 * itself a fix-all delegates to {@link runFixAllCodeAction}.
 */
async function runNestedCodeAction(
  client: LanguageClient | undefined,
  data: unknown,
  output: vscode.OutputChannel,
): Promise<void> {
  const actions = (data as { NestedCodeActions?: NestedAction[] } | undefined)?.NestedCodeActions;
  if (!client || !actions || actions.length === 0) {
    return;
  }

  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({ label: nestedActionLabel(action), action })),
    { placeHolder: vscode.l10n.t("Pick a code action"), ignoreFocusOut: true },
  );
  if (!picked) {
    return;
  }

  const action = picked.action;
  if (action.data.FixAllFlavors) {
    await runFixAllCodeAction(client, action.data, output);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Code Action"), cancellable: true },
    async (_progress, token) => {
      const response = await client.sendRequest<{ edit?: unknown }>(
        CODE_ACTION_RESOLVE,
        { title: action.title, data: action.data },
        token,
      );
      await applyResolvedEdit(client, response.edit, output, "roslyn.client.nestedCodeAction");
    },
  );
}

/**
 * Handles a "Fix all occurrences" action: asks for the fix-all scope (document/project/solution) via a
 * QuickPick, resolves it to a WorkspaceEdit, and applies it.
 */
async function runFixAllCodeAction(
  client: LanguageClient | undefined,
  data: FixAllData | undefined,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!client || !data?.FixAllFlavors) {
    return;
  }

  const scope = await vscode.window.showQuickPick(data.FixAllFlavors, {
    placeHolder: vscode.l10n.t("Pick a fix all scope"),
  });
  if (!scope) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Fix All Code Action"), cancellable: true },
    async (_progress, token) => {
      const response = await client.sendRequest<{ edit?: unknown }>(
        CODE_ACTION_RESOLVE_FIX_ALL,
        { title: data.UniqueIdentifier, data, scope },
        token,
      );
      await applyResolvedEdit(client, response.edit, output, "roslyn.client.fixAllCodeAction");
    },
  );
}

/** Builds the QuickPick label for a nested action from its `CodeActionPath` breadcrumb. */
function nestedActionLabel(action: NestedAction): string {
  const path = action.data.CodeActionPath ?? [action.title];
  const label = path.length <= 1 ? path[0] : path.slice(1).join(" -> ");
  return action.data.FixAllFlavors ? `${vscode.l10n.t("Fix All: ")}${label}` : label;
}

/** Converts a resolved LSP edit to a vscode WorkspaceEdit and applies it, logging on failure. */
async function applyResolvedEdit(
  client: LanguageClient,
  edit: unknown,
  output: vscode.OutputChannel,
  source: string,
): Promise<void> {
  if (!edit) {
    output.appendLine(`[${source}] Server returned a code action with no edit.`);
    return;
  }
  const workspaceEdit = await client.protocol2CodeConverter.asWorkspaceEdit(edit as LspWorkspaceEdit);
  if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
    output.appendLine(`[${source}] Failed to apply the code action edit.`);
  }
}

/**
 * Registers handlers for the Roslyn-specific server→client messages. Call once, after the client
 * has started. Method names are specific to the pinned server version; if a name changes the
 * handler simply never fires, which degrades gracefully rather than breaking the session.
 */
export function registerRoslynProtocol(
  client: LanguageClient,
  state: ServerStateStore,
  output: vscode.OutputChannel,
): void {
  client.onNotification("workspace/projectInitializationComplete", () => {
    state.update({ phase: "running", activity: undefined });
  });

  // The server→client half of a "Debug Test" CodeLens run; see runTests.ts.
  registerAttachDebuggerHandler(client, (message) => output.appendLine(message));

  // Roslyn asks the client to restore projects it can't resolve, so hover/diagnostics work for
  // external libraries. We reuse the existing `dotnet restore` wrapper. Params carry the project
  // file paths (as paths or file: URIs).
  client.onRequest(
    "workspace/_roslyn_projectNeedsRestore",
    async (params: { projectFilePaths?: string[] }) => {
      const paths = params?.projectFilePaths ?? [];
      state.update({ activity: "Restoring packages…" });
      for (const p of paths) {
        try {
          await restore(toFsPath(p));
        } catch {
          // Best-effort: a failed restore must not break the language session.
        }
      }
      state.update({ activity: undefined });
      return null;
    },
  );
}

/**
 * The non-standard open handshake: discover a solution (or loose projects) per the `loadMode` setting
 * and tell the server to load it. Roslyn provides no diagnostics/IntelliSense until this is sent.
 * Discovery is scoped to the mode so large repos don't glob for files a mode will never use.
 */
export async function performHandshake(client: LanguageClient, state: ServerStateStore): Promise<void> {
  const config = vscode.workspace.getConfiguration("csharpSolutionExplorer.languageServer");
  const mode = config.get<LoadMode>("loadMode", "auto");
  const solutionPath = resolveSolutionPath(config.get<string>("solutionPath", ""));

  let solutions: string[] = [];
  let projects: string[] = [];
  let openProjects: string[] = [];

  if (mode === "openProjects") {
    openProjects = await findOpenProjects();
  } else if (mode === "projects") {
    projects = await findFiles(["**/*.csproj"]);
  } else {
    // auto / solution: a solution wins; only auto falls back to loose projects when none is found.
    solutions = solutionPath ? [] : await findFiles(["**/*.sln", "**/*.slnx"]);
    if (mode === "auto" && !solutionPath && solutions.length === 0) {
      projects = await findFiles(["**/*.csproj"]);
    }
  }

  const action = decideHandshake({ mode, solutions, projects, openProjects, solutionPath });

  if (action.kind === "solution") {
    state.update({ solution: action.solution, projects: undefined, activity: "Loading solution…" });
    await client.sendNotification("solution/open", { solution: toUri(action.solution) });
  } else if (action.kind === "projects") {
    state.update({ projects: action.projects, solution: undefined, activity: "Loading projects…" });
    await client.sendNotification("project/open", { projects: action.projects.map(toUri) });
  } else {
    // Nothing to open — clear the "initializing" activity so the status doesn't hang.
    state.update({ solution: undefined, projects: undefined, activity: undefined });
  }
}

/**
 * Resolves the `solutionPath` setting to an absolute fsPath, or `""` when unset/missing. A relative
 * path is taken against the first workspace folder. A configured-but-nonexistent path is dropped (so
 * the mode falls back to discovery) rather than handed to the server as a dead path.
 */
function resolveSolutionPath(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = path.isAbsolute(value) || !root ? value : path.join(root, value);
  return existsSync(abs) ? abs : "";
}

/**
 * The `.csproj` files owning the currently-open C# editors: each open document is mapped to the
 * nearest ancestor project (longest matching project directory). Used by the `openProjects` mode to
 * load a minimal set; Roslyn still pulls in each project's references.
 */
async function findOpenProjects(): Promise<string[]> {
  const allProjects = await findFiles(["**/*.csproj"]);
  const owning = new Set<string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== "file" || !doc.fileName.endsWith(".cs")) {
      continue;
    }
    const project = nearestProject(doc.uri.fsPath, allProjects);
    if (project) {
      owning.add(project);
    }
  }
  return [...owning];
}

/** The project whose directory is the longest ancestor of `file`, if any. */
function nearestProject(file: string, projects: string[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const project of projects) {
    const dir = path.dirname(project) + path.sep;
    if ((file + path.sep).startsWith(dir) && dir.length > bestLen) {
      best = project;
      bestLen = dir.length;
    }
  }
  return best;
}

/** Finds files for the given globs across workspace folders, shallowest path first. */
async function findFiles(globs: string[]): Promise<string[]> {
  const uris: vscode.Uri[] = [];
  for (const glob of globs) {
    uris.push(...(await vscode.workspace.findFiles(glob, EXCLUDE_GLOB)));
  }
  return uris
    .map((u) => u.fsPath)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

const depth = (p: string): number => p.split(/[\\/]/).length;
const toUri = (fsPath: string): string => vscode.Uri.file(fsPath).toString();
const toFsPath = (p: string): string => (p.startsWith("file:") ? vscode.Uri.parse(p).fsPath : p);

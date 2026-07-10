// Orchestrates the C# language server lifecycle: decides whether to run (setting + auto-off when the
// Microsoft C# extension is present), resolves the server (local override or download), starts the
// LSP client, performs the Roslyn handshake, and drives the shared state. Owns restart/dispose.

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { detectRid } from "./rid.js";
import {
  createLanguageClient,
  performHandshake,
  registerRoslynProtocol,
} from "./roslynClient.js";
import {
  ensureServerDownloaded,
  FeedUnreachableError,
  ResolvedServer,
} from "./roslynDownloader.js";
import { ROSLYN_LS_VERSION } from "./roslynPackage.js";
import { localServerKind } from "./roslynServer.js";
import { ServerStateStore } from "./serverState.js";

const MS_EXTENSION_ID = "ms-dotnettools.csharp";
const CONTEXT_RUNNING = "csharpSolutionExplorer.languageServer.running";
const MS_CONFLICT_NOTIFIED_KEY = "languageServer.msConflictNotified";

export class LanguageServerController {
  private client: LanguageClient | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ServerStateStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Starts (or, if already starting, joins the in-flight start). */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  async restart(): Promise<void> {
    this.state.update({ phase: "restarting", activity: "Restarting…" });
    await this.start();
  }

  private async doStart(): Promise<void> {
    await this.stopClient();
    const config = vscode.workspace.getConfiguration("csharpSolutionExplorer.languageServer");

    if (!config.get<boolean>("enabled", true)) {
      this.state.set({ phase: "disabled", detail: "Disabled via settings." });
      await this.setRunningContext(false);
      return;
    }

    if (vscode.extensions.getExtension(MS_EXTENSION_ID)) {
      this.state.set({
        phase: "msExtConflict",
        detail:
          "The Microsoft C# extension is installed; the bundled server stays off to avoid running two language servers.",
      });
      await this.setRunningContext(false);
      await this.notifyMsConflictOnce();
      return;
    }

    const rid = detectRid();
    if (!rid) {
      this.state.set({
        phase: "failed",
        detail: `Unsupported platform/architecture: ${process.platform}/${process.arch}.`,
      });
      await this.setRunningContext(false);
      return;
    }

    const version = config.get<string>("version")?.trim() || ROSLYN_LS_VERSION;
    const logLevel = config.get<string>("logLevel", "Information");
    const serverPathOverride = config.get<string>("serverPath")?.trim();

    try {
      let server: ResolvedServer;
      if (serverPathOverride) {
        server = {
          rid,
          version,
          dir: "",
          entryPath: serverPathOverride,
          kind: localServerKind(serverPathOverride),
        };
      } else {
        this.state.set({ phase: "downloading", rid, version, activity: "Downloading server…" });
        server = await ensureServerDownloaded(this.context.globalStorageUri, rid, version);
      }

      const logDir = this.context.logUri.fsPath;
      await fs.mkdir(logDir, { recursive: true });

      this.state.set({ phase: "starting", rid, version, activity: "Starting server…" });
      const client = await this.startClientWithFallback(server, logLevel, logDir);

      registerRoslynProtocol(client, this.state);
      this.state.update({ phase: "running", activity: "Initializing projects…" });
      await this.setRunningContext(true);
      await performHandshake(client, this.state);
    } catch (err) {
      const detail = err instanceof FeedUnreachableError ? err.message : errMessage(err);
      this.state.set({ phase: "failed", rid, version, detail });
      await this.setRunningContext(false);
      void vscode.window.showErrorMessage(`C# language server failed to start: ${detail}`);
    }
  }

  /**
   * Starts the LSP client. If a native apphost fails to launch (e.g. it can't find the .NET runtime
   * it needs), retries once via `dotnet exec` on the sibling DLL — a runtime is required regardless,
   * and `dotnet` on PATH resolves it.
   */
  private async startClientWithFallback(
    server: ResolvedServer,
    logLevel: string,
    logDir: string,
  ): Promise<LanguageClient> {
    try {
      return await this.launchClient(server, logLevel, logDir);
    } catch (primaryErr) {
      const fallback = dllFallback(server);
      if (!fallback) {
        throw primaryErr;
      }
      this.output.appendLine(
        `[C# Language Server] Native launch failed (${errMessage(primaryErr)}); retrying via 'dotnet exec'.`,
      );
      return this.launchClient(fallback, logLevel, logDir);
    }
  }

  private async launchClient(
    server: ResolvedServer,
    logLevel: string,
    logDir: string,
  ): Promise<LanguageClient> {
    const client = createLanguageClient(server, logLevel, logDir, this.output);
    this.client = client;
    await client.start();
    return client;
  }

  private async stopClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.stop();
      } catch {
        // A server that already exited can throw on stop; nothing to recover.
      }
    }
  }

  private async setRunningContext(running: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", CONTEXT_RUNNING, running);
  }

  private async notifyMsConflictOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(MS_CONFLICT_NOTIFIED_KEY)) {
      return;
    }
    await this.context.globalState.update(MS_CONFLICT_NOTIFIED_KEY, true);
    void vscode.window.showInformationMessage(
      "C# Solution Explorer detected the Microsoft C# extension, so its bundled language server " +
        "stays off to avoid conflicts. Disable the Microsoft C# extension to use the bundled server.",
    );
  }

  /** Shows the language server's output channel. */
  showLogs(): void {
    this.output.show(true);
  }

  async dispose(): Promise<void> {
    await this.stopClient();
    await this.setRunningContext(false);
    this.output.dispose();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** For a downloaded native apphost, the sibling DLL launched via `dotnet exec`, if it exists. */
function dllFallback(server: ResolvedServer): ResolvedServer | undefined {
  if (server.kind !== "exe" || !server.dir) {
    return undefined;
  }
  const dll = path.join(server.dir, "Microsoft.CodeAnalysis.LanguageServer.dll");
  return existsSync(dll) ? { ...server, entryPath: dll, kind: "dll" } : undefined;
}

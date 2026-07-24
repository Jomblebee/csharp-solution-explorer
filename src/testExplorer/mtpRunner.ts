// Drives a Microsoft.Testing.Platform test project through its JSON-RPC server-mode protocol — the
// only way to run MTP projects on the .NET 10 SDK, where the classic VSTest `dotnet test` target is
// gone. Flow (see mtpProtocol.ts): build the test app, open a loopback TCP listener, launch the app
// with `--server --client-host 127.0.0.1 --client-port <port>`, and speak JSON-RPC over the socket
// it connects back on. `initialize` → `testing/runTests` (or `testing/discoverTests`) → collect
// `testing/testUpdates/tests` → `exit`. Debugging is the run flow with `debuggerProvider: true`; the
// server then asks us to `client/attachDebugger` to the test-host pid, which we satisfy by attaching
// netcoredbg.
//
// The wire framing (LSP-style Content-Length headers) is handled by vscode-jsonrpc, so this module
// only implements the message choreography. Discovery and run share one session driver; only the
// request method + params differ.

import * as vscode from "vscode";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { build } from "../solutionExplorer/dotnetCli.js";
import { makeReporter } from "../shared/httpDownload.js";
import { queryProjectOutput } from "../debug/projectOutput.js";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import {
  MTP_CLIENT_NAME,
  MTP_METHODS,
  type MtpAttachDebuggerParams,
  type MtpInitializeParams,
  type MtpTestNode,
  type MtpTestUpdateParams,
} from "./mtpProtocol.js";
import { isActionNode, mtpNodesToResults } from "./mtpResults.js";
import type { TrxTestResult } from "./trxParser.js";

export interface MtpRunResult {
  ok: boolean;
  results: TrxTestResult[];
  /** The built test assembly (.dll), also used as the debugger `program` for symbols. */
  program: string;
  output: string;
}

export interface MtpRunOptions {
  project: TargetProject;
  framework?: string;
  debug: boolean;
  output: vscode.OutputChannel;
  token: vscode.CancellationToken;
  /** Restrict the run to these previously-discovered nodes; omit to run the whole project. */
  filter?: MtpTestNode[];
  /** Called for every test-node update as it streams in — drives live pass/fail reporting. */
  onNode?: (node: MtpTestNode) => void;
  /** Attach a debugger to the test-host pid; returns whether the attach succeeded. */
  onAttachDebugger?: (pid: number, program: string) => Promise<boolean>;
}

export interface MtpDiscoverOptions {
  project: TargetProject;
  framework?: string;
  output: vscode.OutputChannel;
  token: vscode.CancellationToken;
}

export async function runMtpTests(opts: MtpRunOptions): Promise<MtpRunResult> {
  const built = await buildAndResolve(opts.project, opts.framework, opts.output);
  if (!built.ok) {
    return { ok: false, results: [], program: "", output: built.output };
  }

  const collected: MtpTestNode[] = [];
  const ok = await runMtpSession(
    built.program,
    {
      method: MTP_METHODS.runTests,
      debug: opts.debug,
      filter: opts.filter,
      output: opts.output,
      token: opts.token,
      onNode: opts.onNode,
      onAttachDebugger: opts.onAttachDebugger,
    },
    collected,
  );
  return { ok, results: mtpNodesToResults(collected), program: built.program, output: "" };
}

/** Discovers the tests without running them. Returns the action (test) nodes. */
export async function discoverMtpTests(opts: MtpDiscoverOptions): Promise<MtpTestNode[]> {
  const built = await buildAndResolve(opts.project, opts.framework, opts.output);
  if (!built.ok) {
    return [];
  }
  const collected: MtpTestNode[] = [];
  await runMtpSession(
    built.program,
    { method: MTP_METHODS.discoverTests, debug: false, output: opts.output, token: opts.token },
    collected,
  );
  return collected.filter(isActionNode);
}

async function buildAndResolve(
  project: TargetProject,
  framework: string | undefined,
  output: vscode.OutputChannel,
): Promise<{ ok: boolean; program: string; output: string }> {
  output.appendLine(`Building ${project.name}…`);
  const buildResult = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building ${project.name}…`, cancellable: false },
    (progress) => build(project.uri.fsPath, { framework, configuration: "Debug", onProgress: makeReporter(progress) }),
  );
  output.appendLine(buildResult.output);
  if (!buildResult.ok) {
    return { ok: false, program: "", output: buildResult.output };
  }
  const projectOutput = await queryProjectOutput(project.uri.fsPath, framework, "Debug");
  return { ok: true, program: projectOutput.program, output: buildResult.output };
}

interface MtpSessionParams {
  method: string;
  debug: boolean;
  filter?: MtpTestNode[];
  output: vscode.OutputChannel;
  token: vscode.CancellationToken;
  onNode?: (node: MtpTestNode) => void;
  onAttachDebugger?: (pid: number, program: string) => Promise<boolean>;
}

function runMtpSession(program: string, params: MtpSessionParams, collected: MtpTestNode[]): Promise<boolean> {
  const { output, token } = params;

  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    let child: ChildProcess | undefined;
    let connection: MessageConnection | undefined;
    let settled = false;

    const cleanup = (): void => {
      try {
        connection?.dispose();
      } catch {
        /* ignore */
      }
      server.close();
      child?.kill();
    };
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const cancelSub = token.onCancellationRequested(() => finish(false));
    const done = (value: boolean): void => {
      cancelSub.dispose();
      finish(value);
    };

    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      // Force IPv4 to match the 127.0.0.1 listener — "localhost" can resolve to ::1 and never connect.
      child = spawn("dotnet", [program, "--server", "--client-host", "127.0.0.1", "--client-port", String(port)], {
        cwd: path.dirname(program),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TESTINGPLATFORM_EXIT_PROCESS_ON_UNHANDLED_EXCEPTION: "0" },
      });
      child.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          fail(new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to run tests."));
          return;
        }
        fail(err);
      });
      // If the host dies before the run completes, resolve as failed rather than hang.
      child.on("exit", () => {
        if (!settled) {
          done(false);
        }
      });
    });

    server.on("connection", (socket) => {
      void onConnected(socket).catch(fail);
    });

    async function onConnected(socket: net.Socket): Promise<void> {
      connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));

      let resolveComplete: () => void;
      const completed = new Promise<void>((r) => {
        resolveComplete = r;
      });

      connection.onNotification(MTP_METHODS.testUpdates, (update: MtpTestUpdateParams) => {
        if (update.changes === null || update.changes === undefined) {
          resolveComplete();
          return;
        }
        for (const change of update.changes) {
          collected.push(change.node);
          params.onNode?.(change.node);
        }
      });
      connection.onNotification(MTP_METHODS.log, (log: { message?: string; messages?: { message: string }[] }) => {
        const text = log.message ?? log.messages?.map((m) => m.message).join("\n");
        if (text) {
          output.appendLine(text);
        }
      });
      connection.onRequest(MTP_METHODS.attachDebugger, async (attach: MtpAttachDebuggerParams) => {
        const success = params.onAttachDebugger ? await params.onAttachDebugger(attach.processId, program) : false;
        return { success };
      });
      // We do not launch child processes ourselves, so decline launch requests gracefully.
      connection.onRequest(MTP_METHODS.launchDebugger, () => ({ success: false }));

      connection.listen();

      const initParams: MtpInitializeParams = {
        processId: process.pid,
        clientInfo: { name: MTP_CLIENT_NAME, version: "1.0.0" },
        capabilities: { testing: { debuggerProvider: params.debug } },
      };
      await connection.sendRequest(MTP_METHODS.initialize, initParams);

      const runId = randomUUID();
      // Send `tests` only for a filtered run — MTP types it as an array and rejects an explicit null
      // (vscode-jsonrpc serializes nulls, unlike the StreamJsonRpc reference client which drops them).
      const requestParams = params.filter && params.filter.length > 0 ? { runId, tests: params.filter } : { runId };
      await connection.sendRequest(params.method, requestParams);
      // The request response and the "complete" (changes==null) notification can arrive in either
      // order; wait for the completion signal too, with a short guard so a server that never sends it
      // cannot hang the session.
      await Promise.race([completed, delay(2000)]);

      // Await the exit send before tearing down the socket, so the write can't race the dispose into
      // an unhandled ERR_STREAM_DESTROYED. A failure here just means the host already went away.
      try {
        await connection.sendNotification(MTP_METHODS.exit, {});
      } catch {
        /* host already closing */
      }
      done(true);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

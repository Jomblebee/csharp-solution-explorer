// Sits between VS Code and netcoredbg instead of letting VS Code spawn the adapter directly, so
// several kinds of messages can be rewritten or synthesized:
//  - `threads` responses on the way back (see `threadNames.ts`);
//  - for the external-terminal flow (`externalAttach` set), the outgoing `launch` request is rewired
//    into a real `attach` before netcoredbg ever sees it, and the matching response rewired back to
//    look like a `launch` response — see `buildExternalAttachConfig`'s doc comment in debugConfig.ts
//    for why the request is disguised as `launch` in the first place (VS Code's debug toolbar);
//  - for that same flow, an outgoing `disconnect` with no explicit `terminateDebuggee` gets one
//    forced to `true`, so Stop kills the process we spawned instead of merely detaching;
//  - also for that flow, `externalAttach.preSessionLog` (the build/spawn status lines that happened
//    before this adapter existed to send anything) is replayed as synthetic `output` events once the
//    session's Debug Console exists, followed by a live "Debugger attached." once the real attach
//    response comes back — otherwise none of that would ever be visible anywhere but the "C# Debugger"
//    output channel, since `internalConsoleOptions` only controls the Debug Console's *visibility*,
//    not what ends up in it.
// Everything else is forwarded byte-for-byte; this is a pipe, not a protocol implementation.

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";
import { DapMessageParser, encodeDapMessage } from "./dapFraming.js";
import { CommReader, DapThread, nameThreads, readCommFromProc } from "./threadNames.js";

export interface ExternalAttach {
  processId: number;
  program?: string;
  /** Status lines from before this adapter existed, replayed into the Debug Console once it does. */
  preSessionLog?: string[];
}

export class NetcoredbgProxyAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly parser = new DapMessageParser();
  private readonly child: ChildProcessWithoutNullStreams;
  /** Mirrors netcoredbg's numbering so a synthetic event cannot collide with one of its own. */
  private highestSeq = 0;
  private stopped = false;
  /** `seq` of the disguised `launch` request, while its real `attach` response is still pending. */
  private pendingLaunchSeq: number | undefined;

  readonly onDidSendMessage = this.emitter.event;

  constructor(
    command: string,
    args: string[],
    private readonly output: vscode.OutputChannel,
    private readonly externalAttach: ExternalAttach | undefined = undefined,
    private readonly readComm: CommReader = readCommFromProc,
  ) {
    this.child = spawn(command, args, { stdio: "pipe" });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.output.append(chunk.toString("utf8")));
    this.child.on("error", (err) => {
      this.output.appendLine(`Debug adapter failed to start: ${err.message}`);
      this.terminate();
    });
    this.child.on("exit", (code, signal) => {
      this.output.appendLine(`Debug adapter exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
      // VS Code cannot see the process die behind an inline adapter, so the session has to be ended
      // explicitly — otherwise the debug toolbar hangs around forever.
      this.terminate();
    });

    if (this.externalAttach?.preSessionLog?.length) {
      // Deferred to a macrotask: fired synchronously here, this.emitter would have no listener yet —
      // VS Code only subscribes to `onDidSendMessage` after `createDebugAdapterDescriptor`'s promise
      // (which constructs this adapter) resolves, and that subscription itself runs as a microtask
      // continuation. `setImmediate` always drains after those, so the listener is reliably attached
      // by the time this runs.
      const lines = this.externalAttach.preSessionLog;
      setImmediate(() => {
        for (const line of lines) {
          this.emitter.fire(this.outputEvent(line));
        }
      });
    }
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    if (this.stopped) {
      return;
    }
    this.child.stdin.write(encodeDapMessage(this.rewriteOutgoing(message)));
  }

  dispose(): void {
    this.stopped = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    this.emitter.dispose();
  }

  private receive(chunk: Buffer): void {
    const { messages, errors } = this.parser.append(chunk);
    for (const error of errors) {
      this.output.appendLine(`Debug adapter protocol error: ${error}`);
    }
    for (const message of messages) {
      this.trackSeq(message);
      this.emitter.fire(this.rewrite(message) as vscode.DebugProtocolMessage);
    }
  }

  /**
   * Forces `terminateDebuggee: true` on an outgoing `disconnect` request for a session that owns its
   * process. VS Code defaults an `attach`-shaped session's Stop button to detaching (leaving the
   * process running) rather than terminating it — reasonable for attaching to something you don't
   * own, wrong for the external-terminal flow, which spawned the process itself. Only fills the field
   * in when absent, so an explicit choice (e.g. VS Code's own "Disconnect" action) still wins.
   *
   * Also rewrites the disguised `launch` request into the real `attach` netcoredbg needs — see this
   * file's header comment.
   */
  private rewriteOutgoing(message: vscode.DebugProtocolMessage): vscode.DebugProtocolMessage {
    if (!this.externalAttach) {
      return message;
    }
    const candidate = message as { seq?: unknown; type?: unknown; command?: unknown; arguments?: Record<string, unknown> };

    if (candidate.type === "request" && candidate.command === "launch") {
      this.pendingLaunchSeq = typeof candidate.seq === "number" ? candidate.seq : undefined;
      return {
        ...candidate,
        command: "attach",
        arguments: { processId: this.externalAttach.processId, program: this.externalAttach.program },
      } as vscode.DebugProtocolMessage;
    }

    if (candidate.type === "request" && candidate.command === "disconnect" && candidate.arguments?.terminateDebuggee === undefined) {
      return { ...candidate, arguments: { ...candidate.arguments, terminateDebuggee: true } } as vscode.DebugProtocolMessage;
    }

    return message;
  }

  /** Threads get readable names; the disguised launch's response is rewired back from `attach`. */
  private rewrite(message: unknown): unknown {
    if (typeof message !== "object" || message === null) {
      return message;
    }
    const candidate = message as {
      type?: unknown;
      command?: unknown;
      request_seq?: unknown;
      success?: unknown;
      message?: unknown;
      body?: { threads?: unknown };
    };

    if (
      this.pendingLaunchSeq !== undefined &&
      candidate.type === "response" &&
      candidate.command === "attach" &&
      candidate.request_seq === this.pendingLaunchSeq
    ) {
      this.pendingLaunchSeq = undefined;
      // A side effect inside an otherwise-pure rewrite, deliberately: this is the first point at
      // which the real attach outcome is known, and firing here (before returning the rewritten
      // response below) puts the status line ahead of it in the Debug Console, matching reading order.
      this.emitter.fire(
        this.outputEvent(
          candidate.success === false ? `Debugger attach failed: ${String(candidate.message ?? "unknown error")}` : "Debugger attached.",
        ),
      );
      return { ...candidate, command: "launch" };
    }

    if (candidate.type !== "response" || candidate.command !== "threads" || !Array.isArray(candidate.body?.threads)) {
      return message;
    }
    return {
      ...candidate,
      body: { ...candidate.body, threads: nameThreads(candidate.body.threads as DapThread[], this.readComm) },
    };
  }

  /** A synthetic DAP `output` event for the Debug Console — see this file's header comment. */
  private outputEvent(text: string): vscode.DebugProtocolMessage {
    return {
      seq: ++this.highestSeq,
      type: "event",
      event: "output",
      body: { category: "console", output: text.endsWith("\n") ? text : `${text}\n` },
    } as vscode.DebugProtocolMessage;
  }

  private trackSeq(message: unknown): void {
    const seq = (message as { seq?: unknown }).seq;
    if (typeof seq === "number" && seq > this.highestSeq) {
      this.highestSeq = seq;
    }
  }

  private terminate(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.emitter.fire({ seq: ++this.highestSeq, type: "event", event: "terminated" } as vscode.DebugProtocolMessage);
  }
}

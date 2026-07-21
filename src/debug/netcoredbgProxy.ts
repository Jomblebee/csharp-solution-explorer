// Sits between VS Code and netcoredbg instead of letting VS Code spawn the adapter directly, so
// `threads` responses can be rewritten on the way back — see `threadNames.ts` for why. Everything
// else is forwarded byte-for-byte; this is a pipe, not a protocol implementation.

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";
import { DapMessageParser, encodeDapMessage } from "./dapFraming.js";
import { CommReader, DapThread, nameThreads, readCommFromProc } from "./threadNames.js";

export class NetcoredbgProxyAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly parser = new DapMessageParser();
  private readonly child: ChildProcessWithoutNullStreams;
  /** Mirrors netcoredbg's numbering so a synthetic event cannot collide with one of its own. */
  private highestSeq = 0;
  private stopped = false;

  readonly onDidSendMessage = this.emitter.event;

  constructor(
    command: string,
    args: string[],
    private readonly output: vscode.OutputChannel,
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
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    if (this.stopped) {
      return;
    }
    this.child.stdin.write(encodeDapMessage(message));
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

  /** The one message we touch. Anything unexpected is passed through untouched. */
  private rewrite(message: unknown): unknown {
    if (typeof message !== "object" || message === null) {
      return message;
    }
    const candidate = message as { type?: unknown; command?: unknown; body?: { threads?: unknown } };
    if (candidate.type !== "response" || candidate.command !== "threads" || !Array.isArray(candidate.body?.threads)) {
      return message;
    }
    return {
      ...candidate,
      body: { ...candidate.body, threads: nameThreads(candidate.body.threads as DapThread[], this.readComm) },
    };
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

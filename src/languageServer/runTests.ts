// The Roslyn server's "Run Test" / "Debug Test" CodeLens above a `[Fact]`/`[TestMethod]` points at
// the *client* command `dotnet.test.run`, handing it one RunTestsParams (document, range, and an
// `attachDebugger` flag — the same command backs both lenses). With no such command registered VS
// Code answers the click with "command 'dotnet.test.run' not found", so this file is the missing
// half of that contract.
//
// The run itself happens inside the server: `textDocument/runTests` builds and runs the selection and
// streams stages/counts back over a partial-result token while the request is in flight. Debugging is
// server-driven too — with `attachDebugger: true` Roslyn holds the test host until it has asked the
// client, via `workspace/attachDebugger`, to attach to a PID; we attach the bundled netcoredbg (the
// extension's own debug type) and answer whether that worked, which releases the host.
//
// Ported in shape (MIT) from dotnet/vscode-csharp (`lsptoolshost/testing/dotnetTest.ts`), minus the
// C# Dev Kit hand-off and telemetry. vscode-languageclient 10 dropped `sendRequestWithProgress`, so
// the partial-result token is generated and subscribed here instead.
//
// This is deliberately separate from the Test Explorer (`testExplorer/`), which drives its own
// `dotnet test`/MTP runs: a CodeLens run reports into the output channel below, not into the tree.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ProgressType } from "vscode-languageclient";
import { LanguageClient } from "vscode-languageclient/node";
import { buildAttachConfig, DEBUG_TYPE } from "../debug/debugConfig.js";
import { queryProjectOutput } from "../debug/projectOutput.js";
import { errorText } from "../shared/errorText.js";
import { completedCount, formatSummary, progressIncrement, type TestProgress } from "./runTestsProgress.js";

const RUN_TESTS = "textDocument/runTests";
const ATTACH_DEBUGGER = "workspace/attachDebugger";

/** What the CodeLens hands the command; passed back to the server almost verbatim. */
interface RunTestsParams {
  textDocument?: { uri?: string };
  range?: unknown;
  attachDebugger?: boolean;
  partialResultToken?: string;
}

/** One streamed update: a stage name, an optional log line, and cumulative counts once running. */
interface RunTestsPartialResult {
  stage?: string;
  message?: string;
  progress?: TestProgress;
}

/**
 * One run at a time: the server serializes runs anyway, and a second progress notification with its
 * own cancellation token over the same output would only be confusing.
 */
let running = false;

/**
 * The document whose lens started the current run. The server's attach request carries nothing but a
 * PID, so this is what tells the debugger which project's assembly to load symbols from.
 */
let runningDocument: vscode.Uri | undefined;

/**
 * Registers `dotnet.test.run` for the extension's lifetime. Like the other server-facing commands it
 * resolves the client lazily, so it survives server restarts and reports plainly when nothing runs.
 */
export function registerRunTestsCommand(getClient: () => LanguageClient | undefined): vscode.Disposable {
  const output = vscode.window.createOutputChannel("C# Tests (Language Server)");
  return vscode.Disposable.from(
    output,
    vscode.commands.registerCommand("dotnet.test.run", (params: RunTestsParams) =>
      runTests(getClient(), params, output),
    ),
  );
}

/**
 * Answers the server's request to attach a debugger to the test host it just started. Roslyn blocks
 * the run on this response, so it always gets one — `didAttach: false` lets the server tear the host
 * down instead of leaving it suspended forever.
 */
export function registerAttachDebuggerHandler(client: LanguageClient, log: (message: string) => void): void {
  client.onRequest(ATTACH_DEBUGGER, async (params: { processId?: number }) => ({
    didAttach: await attachDebugger(params?.processId, log),
  }));
}

async function runTests(
  client: LanguageClient | undefined,
  params: RunTestsParams,
  output: vscode.OutputChannel,
): Promise<void> {
  const uri = params?.textDocument?.uri;
  if (!uri) {
    return;
  }
  if (!client) {
    void vscode.window.showWarningMessage("The C# language server is not running, so the test cannot be started.");
    return;
  }
  if (running) {
    void vscode.window.showWarningMessage("A test run is already in progress.");
    return;
  }

  running = true;
  runningDocument = parseUri(uri);
  output.show(true);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: params.attachDebugger ? "Debugging tests" : "Running tests",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: "Saving files…" });
        await vscode.workspace.saveAll(false);
        progress.report({ message: "Waiting for the server…" });

        let counted = 0;
        const report = (result: RunTestsPartialResult): void => {
          if (result.message) {
            output.appendLine(result.message);
          }
          if (result.progress) {
            progress.report({
              message: [result.stage, formatSummary(result.progress)].filter(Boolean).join(" — "),
              increment: progressIncrement(result.progress, counted),
            });
            counted = completedCount(result.progress);
          } else if (result.stage) {
            progress.report({ message: result.stage });
          }
        };

        // The server streams updates against this token while the request is still open; the final
        // response repeats them as an array, which vscode-csharp reports too (a run that finishes
        // before the first notification arrives would otherwise show nothing).
        const partialResultToken = randomUUID();
        const subscription = client.onProgress(
          new ProgressType<RunTestsPartialResult | RunTestsPartialResult[]>(),
          partialResultToken,
          (value) => asArray(value).forEach(report),
        );
        try {
          const results = await client.sendRequest<RunTestsPartialResult[]>(
            RUN_TESTS,
            { ...params, partialResultToken },
            token,
          );
          asArray(results).forEach(report);
        } finally {
          subscription.dispose();
        }
      },
    );
  } catch (err) {
    // Includes the cancellation the progress notification's Cancel button triggers, which the server
    // answers with a request-cancelled error — a log line, not an error toast.
    output.appendLine(`Test run ended: ${errorText(err)}`);
  } finally {
    running = false;
  }
}

/** Starts a netcoredbg attach session on `processId`; resolves to whether the session came up. */
async function attachDebugger(processId: number | undefined, log: (message: string) => void): Promise<boolean> {
  if (!processId) {
    return false;
  }
  const name = "C#: Debug tests";
  // The test assembly gives netcoredbg the PDBs that make breakpoints in test methods bind. Without
  // it the attach still works, so a project that cannot be queried degrades to a symbol-less session
  // rather than no session at all.
  const program = await resolveTestAssembly(runningDocument, log);
  const config: vscode.DebugConfiguration = program
    ? buildAttachConfig(name, program, processId)
    : { type: DEBUG_TYPE, request: "attach", name, processId };
  const folder =
    (runningDocument && vscode.workspace.getWorkspaceFolder(runningDocument)) ?? vscode.workspace.workspaceFolders?.[0];
  try {
    const started = await vscode.debug.startDebugging(folder, config);
    if (!started) {
      log(`[dotnet.test.run] Failed to attach the debugger to the test host (pid ${processId}).`);
    }
    return started;
  } catch (err) {
    log(`[dotnet.test.run] Failed to attach the debugger: ${errorText(err)}`);
    return false;
  }
}

/** The `Debug` output assembly of the project owning `document`, or undefined when it can't be found. */
async function resolveTestAssembly(
  document: vscode.Uri | undefined,
  log: (message: string) => void,
): Promise<string | undefined> {
  if (document?.scheme !== "file") {
    return undefined;
  }
  const project = await findContainingProject(path.dirname(document.fsPath));
  if (!project) {
    return undefined;
  }
  try {
    // No framework is named: a multi-targeted project throws AmbiguousFrameworkError and falls
    // through to a symbol-less attach rather than popping a picker the server is waiting on.
    return (await queryProjectOutput(project, undefined, "Debug")).program;
  } catch (err) {
    log(`[dotnet.test.run] Could not resolve the test assembly for ${project}: ${errorText(err)}`);
    return undefined;
  }
}

/** Walks up from `dir` to the nearest directory holding a `.csproj`. */
async function findContainingProject(dir: string): Promise<string | undefined> {
  let current = dir;
  for (;;) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const project = entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".csproj");
    if (project) {
      return path.join(current, project.name);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Server payloads arrive as a single result or a batch depending on the stage; both are iterated. */
function asArray(value: RunTestsPartialResult | RunTestsPartialResult[] | undefined): RunTestsPartialResult[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseUri(uri: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(uri, true);
  } catch {
    return undefined;
  }
}

// Debugging a classic VSTest test project. Runs `dotnet test` with VSTEST_HOST_DEBUG=1, which makes
// the test host print its PID and then spin until a debugger attaches; we watch stdout for that PID
// and attach the bundled netcoredbg via a plain attach config (buildAttachConfig) — reusing the same
// debug type as the rest of the extension, so no new adapter/provider code is needed. Returns the run
// outcome so the controller reports results from the produced TRX exactly like a plain Run.
//
// MTP projects do NOT use this path — see mtpRunner.ts, which attaches via the server protocol.

import * as vscode from "vscode";
import type { TargetProject } from "../solutionExplorer/workspaceProjects.js";
import { buildAttachConfig } from "../debug/debugConfig.js";
import { queryProjectOutput } from "../debug/projectOutput.js";
import { runTests, type TestRunOutcome } from "./dotnetTestRunner.js";
import { parseTestHostPid } from "./dotnetTestArgs.js";

export async function debugTestProject(
  project: TargetProject,
  framework: string | undefined,
  resultsDir: string,
  output: vscode.OutputChannel,
  token: vscode.CancellationToken,
  filter?: string,
): Promise<TestRunOutcome> {
  // The test assembly (.dll) hands netcoredbg the symbols/PDBs so breakpoints in test methods bind.
  const projectOutput = await queryProjectOutput(project.uri.fsPath, framework, "Debug");

  let killChild: (() => void) | undefined;
  let attached = false;

  // Killing the test host ends the netcoredbg session on its own — enough for MVP cancellation.
  const cancelSub = token.onCancellationRequested(() => killChild?.());

  try {
    return await runTests({
      targetFsPath: project.uri.fsPath,
      resultsDir,
      framework,
      filter,
      env: { ...process.env, VSTEST_HOST_DEBUG: "1" },
      onSpawn: (spawned) => {
        killChild = () => spawned.kill();
      },
      onLine: (line) => {
        output.appendLine(line);
        if (attached) {
          return;
        }
        const pid = parseTestHostPid(line);
        if (pid === undefined) {
          return;
        }
        attached = true;
        void vscode.debug
          .startDebugging(folderFor(project), buildAttachConfig(`C#: Debug tests — ${project.name}`, projectOutput.program, pid))
          .then((ok) => {
            if (!ok) {
              output.appendLine("Failed to attach the debugger to the test host.");
            }
          });
      },
    });
  } finally {
    cancelSub.dispose();
  }
}

/** The session's folder — decides `${workspaceFolder}` substitution and multi-root attribution. */
function folderFor(project: TargetProject): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(project.uri) ?? vscode.workspace.workspaceFolders?.[0];
}

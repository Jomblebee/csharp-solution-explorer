// Orchestrates spawning a .NET process in a real external OS terminal and discovering its PID, so
// netcoredbg can `attach` to it instead of `launch`-ing and owning it (see debugConfig.ts's
// `buildAttachConfig` and attachWrapperScript.ts's header for why). Uses `vscode` only indirectly,
// via `runInExternalTerminal`.
//
// `keepOpenAfterExit: false` hands the window's lifetime entirely to the wrapper script — nothing
// wraps it in an extra shell/`-NoExit`, so the script's own pause-vs-auto-close decision is final.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInExternalTerminal, runInIntegratedTerminal, shQuote } from "../../solutionExplorer/externalTerminal.js";
import { waitForPidFile } from "./attachPidFile.js";
import { AttachSpawnRequest, buildPosixWrapperScript, buildWindowsWrapperScript } from "./attachWrapperScript.js";

/** Where the program's console lives: a native OS window, or a VS Code integrated terminal (both real ptys). */
export type TerminalHost = "external" | "integrated";

export type AttachSpawnOptions = Omit<AttachSpawnRequest, "pidFilePath"> & {
  /** The console host for the spawned program. Defaults to `"external"`. */
  host?: TerminalHost;
  /** Terminal name for the `"integrated"` host (ignored for `"external"`). */
  terminalName?: string;
};

/**
 * Writes a temp wrapper script, runs it in a real pty — either a native OS terminal
 * (`runInExternalTerminal`, the same per-OS mechanism Ctrl+F5 uses, minus its keep-open trailer) or a
 * VS Code integrated terminal (`opts.host === "integrated"`) — then polls the pidfile the script
 * writes before backgrounding the process. Never assumes the terminal's own immediate child is the
 * target process — it usually isn't (`cmd.exe`, `x-terminal-emulator`, the user's login shell, …),
 * hence the pidfile handoff. Both hosts are real ptys, so the wrapper's `< /dev/tty` stdin redirect
 * gives the program interactive input either way.
 */
export async function spawnForAttach(opts: AttachSpawnOptions): Promise<number> {
  const { host = "external", terminalName, ...spawnOpts } = opts;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cse-attach-"));
  const pidFilePath = path.join(dir, "pid.txt");
  const req: AttachSpawnRequest = { ...spawnOpts, pidFilePath };

  let command: string;
  if (process.platform === "win32") {
    const scriptPath = path.join(dir, "run.ps1");
    await fsp.writeFile(scriptPath, buildWindowsWrapperScript(req), "utf8");
    // No `-NoExit`: the .ps1 script itself decides whether to pause before its window closes.
    command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
  } else {
    const scriptPath = path.join(dir, "run.sh");
    await fsp.writeFile(scriptPath, buildPosixWrapperScript(req), { mode: 0o755 });
    command = `bash ${shQuote(scriptPath)}`;
  }

  // The wrapper script owns the window's lifetime (pause-and-wait vs. auto-close — see
  // attachWrapperScript.ts) and, via its own `trap`/`finally`, its temp directory's cleanup too —
  // this function only learns the PID long before the script actually exits, so it can't safely
  // delete `dir` itself on the success path.
  if (host === "integrated") {
    runInIntegratedTerminal(terminalName ?? "C#: Debug", req.cwd, command);
  } else {
    await runInExternalTerminal(req.cwd, command, { keepOpenAfterExit: false });
  }
  try {
    return await waitForPidFile(pidFilePath, 10_000, 100);
  } catch (err) {
    // The one case the script's own cleanup can't cover: it never got far enough to run at all
    // (terminal never opened, wrong shell on PATH, ...), so nothing will ever fire its trap/finally.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

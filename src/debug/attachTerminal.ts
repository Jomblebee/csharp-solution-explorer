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
import { runInExternalTerminal, shQuote } from "../solutionExplorer/externalTerminal.js";
import { waitForPidFile } from "./attachPidFile.js";
import { AttachSpawnRequest, buildPosixWrapperScript, buildWindowsWrapperScript } from "./attachWrapperScript.js";

export type AttachSpawnOptions = Omit<AttachSpawnRequest, "pidFilePath">;

/**
 * Writes a temp wrapper script, runs it via the existing `runInExternalTerminal` (same per-OS
 * terminal-opening mechanism Ctrl+F5 already uses, just without its keep-open trailer — see below),
 * then polls the pidfile the script writes before backgrounding the process. Never assumes the
 * terminal's own immediate child is the target process — it usually isn't (`cmd.exe`,
 * `x-terminal-emulator`, …), hence the pidfile handoff.
 */
export async function spawnForAttach(opts: AttachSpawnOptions): Promise<number> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cse-attach-"));
  const pidFilePath = path.join(dir, "pid.txt");
  const req: AttachSpawnRequest = { ...opts, pidFilePath };

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
  // attachWrapperScript.ts), so nothing should re-open a shell behind it once the script exits.
  await runInExternalTerminal(req.cwd, command, { keepOpenAfterExit: false });
  try {
    return await waitForPidFile(pidFilePath, 10_000, 100);
  } finally {
    await fsp.unlink(pidFilePath).catch(() => {});
  }
}

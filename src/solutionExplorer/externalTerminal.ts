import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Runs `command` in a native OS terminal window with working directory `cwd`. This is the
 * "run without a debugger, in a real console" path: netcoredbg cannot place a *debugged* program in
 * a terminal (it always routes output to the Debug Console), so an external console is only possible
 * for a plain run. VS Code has no cross-platform external-terminal API, hence the per-OS branches.
 * The `detached`/`unref` pair lets the window outlive the extension host.
 */
export async function runInExternalTerminal(cwd: string, command: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await runOnMac(cwd, command);
    } else if (process.platform === "win32") {
      runOnWindows(cwd, command);
    } else {
      runOnLinux(cwd, command);
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not open an external terminal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** POSIX-shell single-quote escaping. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runOnMac(cwd: string, command: string): Promise<void> {
  // `open -a Terminal <file>` runs the file in a new Terminal window. A throwaway `.command` script
  // sidesteps the quote-escaping minefield of an inline osascript `do script`.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cse-run-"));
  const script = path.join(dir, "run.command");
  await fsp.writeFile(script, `#!/bin/bash\ncd ${shQuote(cwd)}\n${command}\n`, { mode: 0o755 });
  detached("open", ["-a", "Terminal", script]);
}

function runOnWindows(cwd: string, command: string): void {
  // `start "" cmd /k <command>` opens a console that stays open after the program exits (`/k`).
  // windowsVerbatimArguments keeps Node from re-quoting the paths already quoted inside `command`.
  const child = spawn("cmd.exe", ["/c", `start "" cmd /k ${command}`], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.on("error", reportSpawnError("cmd.exe"));
  child.unref();
}

function runOnLinux(cwd: string, command: string): void {
  // Honour VS Code's configured external terminal; `x-terminal-emulator` is the Debian alternatives
  // entry present on most desktops. `exec bash` keeps the window open after the program exits.
  const exec =
    vscode.workspace.getConfiguration("terminal.external").get<string>("linuxExec")?.trim() || "x-terminal-emulator";
  detached(exec, ["-e", "bash", "-c", `cd ${shQuote(cwd)}; ${command}; exec bash`]);
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", reportSpawnError(cmd));
  child.unref();
}

function reportSpawnError(cmd: string): (err: Error) => void {
  return (err) => vscode.window.showErrorMessage(`Could not open an external terminal ('${cmd}'): ${err.message}`);
}

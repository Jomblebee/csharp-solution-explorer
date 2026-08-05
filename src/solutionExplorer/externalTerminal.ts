import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { msbuildEnv, msbuildNodeEnv } from "../shared/msbuild.js";

export interface ExternalTerminalOptions {
  /**
   * Whether the window stays open (a live shell prompt) after `command` exits. Default `true` —
   * matches Ctrl+F5's Visual-Studio-style "console stays open so you can read the output". The
   * external-terminal debug flow (`attachTerminal.ts`) passes `false`: its own wrapper script decides
   * whether to pause, so nothing should re-open a shell behind it once that script exits.
   */
  keepOpenAfterExit?: boolean;
}

/**
 * Runs `command` in a native OS terminal window with working directory `cwd`. This is the
 * "run without a debugger, in a real console" path: netcoredbg cannot place a *debugged* program in
 * a terminal (it always routes output to the Debug Console), so an external console is only possible
 * for a plain run. VS Code has no cross-platform external-terminal API, hence the per-OS branches.
 * The `detached`/`unref` pair lets the window outlive the extension host.
 */
export async function runInExternalTerminal(cwd: string, command: string, opts: ExternalTerminalOptions = {}): Promise<void> {
  const keepOpenAfterExit = opts.keepOpenAfterExit ?? true;
  try {
    if (process.platform === "darwin") {
      await runOnMac(cwd, command);
    } else if (process.platform === "win32") {
      runOnWindows(cwd, command, keepOpenAfterExit);
    } else {
      runOnLinux(cwd, command, keepOpenAfterExit);
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not open an external terminal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Runs `command` in a fresh VS Code *integrated* terminal (a real pty, so a program spawned there can
 * read interactive input — unlike netcoredbg's Debug Console). Used by the integrated-terminal
 * spawn-then-attach debug flow, mirroring `runInExternalTerminal` but hosted inside the editor.
 *
 * A new terminal each call (not a reused named one) keeps each debug session's console isolated. The
 * wrapper script itself `cd`s too, but passing `cwd` makes the prompt correct if the script is slow to
 * start. `command` is a full `bash <script>` / `powershell -File <script>` line, so it runs correctly
 * regardless of the user's default shell.
 */
export function runInIntegratedTerminal(name: string, cwd: string, command: string): void {
  const terminal = vscode.window.createTerminal({ name, cwd, env: msbuildNodeEnv() });
  terminal.show();
  terminal.sendText(command);
}

/** POSIX-shell single-quote escaping. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runOnMac(cwd: string, command: string): Promise<void> {
  // `open -a Terminal <file>` runs the file in a new Terminal window. A throwaway `.command` script
  // sidesteps the quote-escaping minefield of an inline osascript `do script`.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cse-run-"));
  const script = path.join(dir, "run.command");
  // `trap ... EXIT` cleans up this script's own temp dir once it's done — the extension itself has no
  // handle on the detached Terminal window, so it can never know when to delete this otherwise.
  // `shQuote` applied twice, deliberately: see attachWrapperScript.ts's matching comment — nesting is
  // required for a `dir` containing a space to survive being spliced into the outer `trap '...'`.
  const cleanupCommand = `rm -rf ${shQuote(dir)}`;
  await fsp.writeFile(
    script,
    `#!/bin/bash\ntrap ${shQuote(cleanupCommand)} EXIT\ncd ${shQuote(cwd)}\n${command}\n`,
    { mode: 0o755 },
  );
  detached("open", ["-a", "Terminal", script]);
}

function runOnWindows(cwd: string, command: string, keepOpenAfterExit: boolean): void {
  // `cmd /k <command>` opens a console that stays open (a fresh prompt) after the program exits;
  // `cmd /c` closes the window as soon as `command` finishes, leaving `command` itself in charge of
  // any "press a key to close" pause.
  // windowsVerbatimArguments keeps Node from re-quoting the paths already quoted inside `command`.
  const child = spawn("cmd.exe", ["/c", `start "" cmd /${keepOpenAfterExit ? "k" : "c"} ${command}`], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
    // The window runs `dotnet run`, which builds — so it inherits the node-reuse policy too.
    env: msbuildEnv(),
  });
  child.on("error", reportSpawnError("cmd.exe"));
  child.unref();
}

function runOnLinux(cwd: string, command: string, keepOpenAfterExit: boolean): void {
  // Honour VS Code's configured external terminal; `x-terminal-emulator` is the Debian alternatives
  // entry present on most desktops. `exec bash` keeps the window open (a fresh prompt) after the
  // program exits; omitting it lets the terminal emulator close the window on its own once `command`
  // finishes, leaving `command` itself in charge of any "press a key to close" pause.
  const exec =
    vscode.workspace.getConfiguration("terminal.external").get<string>("linuxExec")?.trim() || "x-terminal-emulator";
  const shellCommand = keepOpenAfterExit
    ? `cd ${shQuote(cwd)}; ${command}; exec bash`
    : `cd ${shQuote(cwd)}; ${command}`;
  detached(exec, ["-e", "bash", "-c", shellCommand]);
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", env: msbuildEnv() });
  child.on("error", reportSpawnError(cmd));
  child.unref();
}

function reportSpawnError(cmd: string): (err: Error) => void {
  return (err) => vscode.window.showErrorMessage(`Could not open an external terminal ('${cmd}'): ${err.message}`);
}

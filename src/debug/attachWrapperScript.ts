// Builds the wrapper scripts that spawn a .NET process in a real external terminal and capture its
// PID, so netcoredbg can `attach` to it instead of `launch`-ing and owning it (see attachTerminal.ts
// for the orchestration, and CHANGELOG.md's netcoredbg entry for why `launch` cannot show a real
// console). Pure — no vscode/child_process import — so the exact script text stays unit-testable.

export interface AttachSpawnRequest {
  cwd: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  pidFilePath: string;
  /** Delays the program's start, biasing (not guaranteeing) the attach-before-first-line race. */
  startupDelayMs?: number;
}

/** POSIX-shell single-quote escaping (mirrors externalTerminal.ts's shQuote). */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Bash script for macOS/Linux. Backgrounds `dotnet exec` (`&`) rather than `exec`-replacing the
 * shell, so the script can still print an exit message and hold the window open afterward — `$!`
 * right after `&` is still exactly the target PID, since `dotnet exec <dll>` never forks further.
 * Statements are newline-joined, not `;`-joined: `cmd &; next` is a bash syntax error.
 *
 * Only pauses for a keypress when the program exited on its own — a debugger-initiated Stop kills it
 * via a signal (netcoredbg's `ICorDebugProcess::Terminate` ultimately does this on Linux/macOS), which
 * `wait` reports as an exit status of 128+signal; a normal .NET exit essentially never reaches that
 * range. `spawnForAttach` also passes `keepOpenAfterExit: false` to `runInExternalTerminal`, so this
 * script fully owns the window's lifetime — nothing re-opens a shell behind it either way.
 */
export function buildPosixWrapperScript(req: AttachSpawnRequest): string {
  const lines: string[] = ["#!/bin/bash", `cd ${posixQuote(req.cwd)}`];
  for (const [key, value] of Object.entries(req.env)) {
    lines.push(`export ${key}=${posixQuote(value)}`);
  }
  if (req.startupDelayMs !== undefined && req.startupDelayMs > 0) {
    lines.push(`sleep ${(req.startupDelayMs / 1000).toFixed(3)}`);
  }
  const argv = ["dotnet", "exec", req.program, ...req.args].map(posixQuote).join(" ");
  lines.push(
    `${argv} &`,
    "pid=$!",
    `echo $pid > ${posixQuote(req.pidFilePath)}`,
    "wait $pid",
    "status=$?",
    "if [ $status -ge 128 ]; then",
    "  exit $status",
    "fi",
    "echo",
    'echo "Process exited (exit code $status). Press Enter to close this terminal."',
    "read -r _",
  );
  return `${lines.join("\n")}\n`;
}

/** PowerShell single-quote escaping: doubles an embedded `'`. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Win32/CreateProcess command-line quoting for one argument, applied before the argument becomes a
 * PowerShell array element — `Start-Process -ArgumentList` on Windows PowerShell 5.1 space-joins the
 * array as-is rather than re-quoting it, so an unquoted element containing a space would be split.
 */
function winArgQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * PowerShell script for Windows. `Start-Process -PassThru -NoNewWindow` is meant to run `dotnet` as a
 * child sharing the parent PowerShell console instead of opening its own window — this is the
 * riskiest, least-verified part of the whole external-terminal-attach design (see the plan's
 * verification notes) and must be confirmed on a real Windows machine before this is trusted.
 *
 * Unlike the POSIX script, this always pauses for a keypress: `ICorDebugProcess::Terminate(0)` sets
 * the Win32 exit code to a literal `0` — identical to a normal clean exit — so a debugger-initiated
 * Stop cannot be told apart from the program finishing on its own. `spawnForAttach` still spawns this
 * without a `cmd /k` keep-open trailer, so at least the window closes on its own once Enter is pressed
 * instead of dropping into a leftover shell prompt.
 */
export function buildWindowsWrapperScript(req: AttachSpawnRequest): string {
  const lines: string[] = [`Set-Location -LiteralPath ${psQuote(req.cwd)}`];
  for (const [key, value] of Object.entries(req.env)) {
    lines.push(`$env:${key} = ${psQuote(value)}`);
  }
  if (req.startupDelayMs !== undefined && req.startupDelayMs > 0) {
    lines.push(`Start-Sleep -Milliseconds ${Math.round(req.startupDelayMs)}`);
  }
  const argv = ["exec", req.program, ...req.args];
  const argList = argv.map((arg) => psQuote(winArgQuote(arg))).join(", ");
  lines.push(
    `$p = Start-Process -FilePath 'dotnet' -ArgumentList @(${argList}) -PassThru -NoNewWindow`,
    `$p.Id | Out-File -FilePath ${psQuote(req.pidFilePath)} -Encoding ascii`,
    "Wait-Process -Id $p.Id",
    'Write-Host ""',
    'Write-Host "Process exited. Press Enter to close this window."',
    "Read-Host | Out-Null",
  );
  return `${lines.join("\r\n")}\r\n`;
}

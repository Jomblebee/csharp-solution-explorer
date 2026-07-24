// Builds the wrapper scripts that spawn a .NET process in a real external terminal and capture its
// PID, so netcoredbg can `attach` to it instead of `launch`-ing and owning it (see attachTerminal.ts
// for the orchestration, and CHANGELOG.md's netcoredbg entry for why `launch` cannot show a real
// console). Pure — no vscode/child_process import — so the exact script text stays unit-testable.

import * as path from "node:path";

export interface AttachSpawnRequest {
  cwd: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  pidFilePath: string;
}

/** POSIX-shell single-quote escaping (mirrors externalTerminal.ts's shQuote). */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// The shared shell/PowerShell identifier grammar. An environment-variable *name* outside this shape
// would otherwise be spliced unquoted into `export <name>=...` / `$env:<name> = ...` — the value is
// already quoted, but the name never was, which is a shell-injection path straight from a
// `launchSettings.json` an untrusted opened repo controls. Silently dropping the entry (rather than
// throwing and aborting the whole debug session over one bad key) matches this codebase's existing
// fail-open style for malformed project input.
const VALID_ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validEnvEntries(env: Record<string, string>): Array<[string, string]> {
  return Object.entries(env).filter(([key]) => VALID_ENV_VAR_NAME.test(key));
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
 *
 * The `trap ... EXIT` is this script's own temp directory's cleanup: it fires on every exit path
 * below (including the early `exit $status` branch), so `spawnForAttach` doesn't need to — and
 * safely can't, since the extension only learns the PID long before this script actually exits.
 */
export function buildPosixWrapperScript(req: AttachSpawnRequest): string {
  const dir = path.dirname(req.pidFilePath);
  // `posixQuote` applied twice, deliberately: `rm -rf ${posixQuote(dir)}` is itself the *content* of
  // the `trap` argument, so it needs to go through `posixQuote` again to nest correctly if `dir`
  // contains a space (temp dirs under an unusual `TMPDIR` can). Splicing `posixQuote(dir)` directly
  // into an already-single-quoted `trap '...'` string breaks exactly that case.
  const cleanupCommand = `rm -rf ${posixQuote(dir)}`;
  const lines: string[] = ["#!/bin/bash", `trap ${posixQuote(cleanupCommand)} EXIT`, `cd ${posixQuote(req.cwd)}`];
  for (const [key, value] of validEnvEntries(req.env)) {
    lines.push(`export ${key}=${posixQuote(value)}`);
  }
  const argv = ["dotnet", "exec", req.program, ...req.args].map(posixQuote).join(" ");
  lines.push(
    // `< /dev/tty`: a background command (`&`) in a *non-interactive* shell has its stdin redirected
    // to /dev/null by POSIX rule, so without this the program sees redirected input and any
    // `Console.ReadKey`/interactive read throws "console input has been redirected" — even though it
    // runs inside a real terminal window. `/dev/tty` is the wrapper's controlling terminal (the
    // emulator/Terminal.app pty), reconnecting a real TTY so interactive input works. No SIGTTIN: with
    // no job control the background process shares the shell's (foreground) process group.
    `${argv} < /dev/tty &`,
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
 *
 * Follows the documented `CommandLineToArgvW` escaping rule, not just "backslash the quotes":
 * backslashes only need doubling when they immediately precede a literal `"` (embedded, or trailing
 * right before the closing quote this function adds) — anywhere else a backslash is already
 * unambiguous and must be left alone. A version that unconditionally leaves backslashes untouched
 * breaks on a value ending in `\` (any path is one), since the run of backslashes right before the
 * closing quote would then escape *that* quote instead of terminating the argument.
 */
function winArgQuote(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      result += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
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
 *
 * The whole body runs inside `try { } finally { Remove-Item ... }` so this script's own temp
 * directory is cleaned up on every exit path — `spawnForAttach` can't do this itself (it only learns
 * the PID long before this script actually exits). `-ErrorAction SilentlyContinue` on the delete
 * matters: whether Windows still holds this very file open at that point is unverified (see above),
 * so a failed delete must not surface as an error — worst case it just leaves the temp files behind,
 * same as before this fix.
 */
export function buildWindowsWrapperScript(req: AttachSpawnRequest): string {
  const dir = path.dirname(req.pidFilePath);
  const body: string[] = [`Set-Location -LiteralPath ${psQuote(req.cwd)}`];
  for (const [key, value] of validEnvEntries(req.env)) {
    body.push(`$env:${key} = ${psQuote(value)}`);
  }
  const argv = ["exec", req.program, ...req.args];
  const argList = argv.map((arg) => psQuote(winArgQuote(arg))).join(", ");
  body.push(
    `$p = Start-Process -FilePath 'dotnet' -ArgumentList @(${argList}) -PassThru -NoNewWindow`,
    `$p.Id | Out-File -FilePath ${psQuote(req.pidFilePath)} -Encoding ascii`,
    "Wait-Process -Id $p.Id",
    'Write-Host ""',
    'Write-Host "Process exited. Press Enter to close this window."',
    "Read-Host | Out-Null",
  );
  const lines = [
    "try {",
    ...body.map((line) => `  ${line}`),
    "} finally {",
    `  Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    "}",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

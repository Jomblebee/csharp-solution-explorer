// Spawns `dotnet test --logger trx`, streams its output line-by-line, and locates the produced .trx.
// Modeled on dotnetCli.build: stdio ignore/pipe/pipe, resolves on `close`, and deliberately does not
// throw on a non-zero exit (failing tests are an expected outcome, not an exception). vscode-free —
// only node APIs — so the vscode layer (testController) does the result reporting.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildTestArgs } from "./dotnetTestArgs.js";

export interface TestRunOutcome {
  /** Whether `dotnet test` exited 0. False also covers a failed build or a failing test. */
  ok: boolean;
  /** Combined stdout+stderr, shown verbatim when no results file is produced. */
  output: string;
  /** Absolute path to the newest `.trx` in the results directory, if any was written. */
  trxPath?: string;
}

export interface RunTestsOptions {
  targetFsPath: string;
  resultsDir: string;
  framework?: string;
  /** VSTest `--filter` expression; omit to run the whole project. */
  filter?: string;
  /** Extra environment (e.g. `VSTEST_HOST_DEBUG=1`); defaults to the current process env. */
  env?: NodeJS.ProcessEnv;
  /** Called for every complete stdout line (CR-trimmed) — drives PID capture and logging. */
  onLine?: (line: string) => void;
  /** Handed the spawned child so the caller can kill it on cancellation. */
  onSpawn?: (child: ChildProcess) => void;
}

export async function runTests(opts: RunTestsOptions): Promise<TestRunOutcome> {
  const args = buildTestArgs(opts.targetFsPath, opts.resultsDir, opts.framework, opts.filter);

  return new Promise<TestRunOutcome>((resolve, reject) => {
    const child = spawn("dotnet", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });
    opts.onSpawn?.(child);

    let output = "";
    let stdoutRest = "";

    const feedStdout = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output += text;
      const lines = (stdoutRest + text).split("\n");
      stdoutRest = lines.pop() ?? "";
      for (const line of lines) {
        opts.onLine?.(line.replace(/\r$/, ""));
      }
    };

    child.stdout.on("data", feedStdout);
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("The 'dotnet' CLI was not found on PATH. Install the .NET SDK to run tests."));
        return;
      }
      resolve({ ok: false, output: output.trim() || err.message });
    });
    child.on("close", (code) => {
      if (stdoutRest.length > 0) {
        opts.onLine?.(stdoutRest.replace(/\r$/, ""));
      }
      void findNewestTrx(opts.resultsDir).then((trxPath) => resolve({ ok: code === 0, output, trxPath }));
    });
  });
}

async function findNewestTrx(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".trx")) {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(dir, entry));
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { file: entry, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Skip an entry that vanished between readdir and stat.
    }
  }
  return newest ? path.join(dir, newest.file) : undefined;
}

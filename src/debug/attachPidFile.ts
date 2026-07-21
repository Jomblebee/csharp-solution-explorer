// Parses and polls the pidfile a wrapper script (attachWrapperScript.ts) writes. Pure except for the
// `node:fs/promises` read — no `vscode` import — so `parsePidFileContents` stays unit-testable
// without an extension host (attachTerminal.ts, which does import `vscode` transitively, only wires
// this up to the actual spawn).

import * as fsp from "node:fs/promises";

/** Only digits, so `"123abc"`/decimals/negatives are rejected rather than silently truncated. */
export function parsePidFileContents(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const pid = Number.parseInt(trimmed, 10);
  return pid > 0 ? pid : undefined;
}

export async function waitForPidFile(pidFilePath: string, timeoutMs: number, pollIntervalMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = parsePidFileContents(await fsp.readFile(pidFilePath, "utf8"));
      if (pid !== undefined) {
        return pid;
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the program to start in the external terminal.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

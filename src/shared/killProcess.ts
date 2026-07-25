// Kills a spawned child *and its descendants*. `dotnet test` / `dotnet <app> --server` launch a
// separate test-host grandchild; a plain child.kill() only signals the launcher, leaving the host
// running. To reach the whole tree we spawn children as their own process-group leaders (detached on
// POSIX — see `detachedSpawnOptions`) and signal the negative pgid; on Windows we shell out to
// `taskkill /t`. Pure node — no native deps, matching the extension's single-VSIX constraint.

import { spawn, type ChildProcess } from "node:child_process";

/** Spawn options that make the child a process-group leader on POSIX so `killTree` can reach the group. */
export const detachedSpawnOptions: { detached: boolean } = { detached: process.platform !== "win32" };

/** Terminates `child` and every descendant. Best-effort and never throws (a dead process is success). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    // /t = terminate the whole tree, /f = force. Runs detached; failures (already-gone) are ignored.
    try {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).on("error", () => {});
    } catch {
      /* ignore */
    }
    return;
  }

  // Signal the process group (negative pid). Falls back to the lone child if it wasn't a group leader.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Escalate to SIGKILL if the tree ignores SIGTERM. No-op (ESRCH, swallowed) once the group is empty.
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2000).unref();
}

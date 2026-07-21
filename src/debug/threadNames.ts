// netcoredbg reports a thread's managed `Thread.Name`, and the runtime's own threads (threadpool
// workers, finalizer, timer) have none — so VS Code's call stack shows a column of "<No name>".
// The ids it reports are Linux tids, and the CLR does name its threads at the OS level, so
// /proc/<tid>/comm turns them back into something readable. `/proc/<tid>` resolves even though the
// tid is not listed in /proc. Other platforms have no equivalent, so they fall back to the bare id.

import * as fs from "node:fs";

/** netcoredbg's literal placeholder for a thread with no managed name. */
const UNNAMED = "<No name>";

export interface DapThread {
  id?: unknown;
  name?: unknown;
}

/** Reads an OS-level thread name. Injectable so the naming rules can be tested off-Linux. */
export type CommReader = (tid: number) => string | undefined;

/**
 * The name to show for a thread. Threads the user named themselves keep that name untouched — it is
 * strictly more informative than anything the OS has.
 */
export function describeThread(thread: DapThread, readComm: CommReader = readCommFromProc): string | undefined {
  const name = typeof thread.name === "string" ? thread.name : undefined;
  if (name !== undefined && name !== UNNAMED && name.trim() !== "") {
    return name;
  }
  const tid = typeof thread.id === "number" && Number.isInteger(thread.id) && thread.id > 0 ? thread.id : undefined;
  if (tid === undefined) {
    return name;
  }

  const comm = readComm(tid);
  // The id is appended because the OS name is not unique — a process has many ".NET TP Worker"s.
  return comm ? `${comm} (${tid})` : `Thread ${tid}`;
}

/** Rewrites the `threads` array of a DAP response in place-free fashion. */
export function nameThreads(threads: DapThread[], readComm: CommReader = readCommFromProc): DapThread[] {
  return threads.map((thread) => {
    const name = describeThread(thread, readComm);
    return name === undefined ? thread : { ...thread, name };
  });
}

/**
 * Synchronous on purpose: this runs inside the message pump, and awaiting here would let a later
 * message overtake an earlier one. It is a read of a few bytes from an in-memory filesystem.
 */
export function readCommFromProc(tid: number): string | undefined {
  // TODO: macOS and Windows currently get `Thread <id>` only — netcoredbg reports no name but
  // "Main Thread", so nothing else is left to show. Both platforms *can* supply the real names, but
  // only through native calls, which is why this is not done yet:
  //   - Windows: OpenThread(THREAD_QUERY_LIMITED_INFORMATION) + GetThreadDescription. Well
  //     documented, needs no elevation for a child process we spawned ourselves. No in-box CLI
  //     exposes it (WMI's Win32_Thread.Name is CIM boilerplate, not the SetThreadDescription value),
  //     and System.Diagnostics.ProcessThread has no name property — see dotnet/runtime#95800.
  //   - macOS: proc_pidinfo(PROC_PIDLISTTHREADS) + PROC_PIDTHREADINFO exposes `pth_name` and, going
  //     by the XNU sources, needs neither task_for_pid nor an entitlement. Unverified though: every
  //     known consumer (lldb, htop) takes the task-port route instead, so test it before relying on
  //     it. A second debugger cannot attach while netcoredbg holds the process, but this call is
  //     unaffected by that.
  // The blocker is packaging, not the APIs: reaching them means an FFI dependency (koffi >= 3.1.1 —
  // earlier versions ship no win32-arm64 binary) and therefore a separate VSIX per platform, where a
  // mispackaged build fails hard at load instead of degrading. Not worth it for a label; revisit if
  // a native dependency arrives for other reasons.
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const comm = fs.readFileSync(`/proc/${tid}/comm`, "utf8").trim();
    return comm === "" ? undefined : comm;
  } catch {
    // The thread died between the response and this read, or /proc is not mounted.
    return undefined;
  }
}

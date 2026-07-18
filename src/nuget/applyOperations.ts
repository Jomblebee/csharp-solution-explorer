// The install / update / uninstall loops, with the `dotnet` calls injected rather than imported.
// This is the code that actually changes the user's projects, so failure isolation, cancellation and
// progress counting are worth testing — and they can only be tested if nothing here reaches for the
// real CLI or for vscode. The wiring to `dotnetCli` lives in nugetManagerService.

/** The `dotnet` package operations, injected so the loops below can be exercised with fakes. */
export interface PackageOps {
  add(projectFsPath: string, id: string, version?: string): Promise<void>;
  remove(projectFsPath: string, id: string): Promise<void>;
  restore(projectFsPath: string): Promise<void>;
}

/**
 * The part of `vscode.CancellationToken` these loops use. A real token satisfies it structurally,
 * which keeps vscode out of this module (and therefore out of the tests').
 */
export interface CancelSignal {
  readonly isCancellationRequested: boolean;
}

export interface ApplyResult {
  project: string;
  ok: boolean;
  error?: string;
}

/** A single step reported while an apply/update batch runs, so callers can drive a progress UI. */
export interface ApplyProgress {
  /** How many units (projects for a single package, packages for a batch) have completed. */
  done: number;
  /** Total number of units in this operation. */
  total: number;
  /** Package id of the unit that just finished. */
  id: string;
  /** Project name of the unit that just finished, when the unit is a project. */
  project?: string;
}

/** One package's update outcome across the projects it was applied to. */
export interface BatchEntryResult {
  id: string;
  results: ApplyResult[];
}

// `commandUtils.errorMessage` would be the natural reuse here, but that module imports vscode and
// would drag it into this one's import graph — and thus into the tests'.
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Applies a package operation to each of `projects`, isolating failures so one bad project does not
 * abort the rest. Install/update both go through `add` (which restores); uninstall runs `remove`
 * followed by an explicit restore so the assets file reflects the change.
 *
 * `onProgress` fires after each project so callers can show step-by-step progress; `token` lets the
 * user cancel — the loop stops before the next project and returns whatever completed so far.
 */
export async function applyPackageWith(
  ops: PackageOps,
  op: "install" | "update" | "uninstall",
  id: string,
  version: string | undefined,
  projects: readonly { name: string; fsPath: string }[],
  onProgress?: (progress: ApplyProgress) => void,
  token?: CancelSignal,
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  let done = 0;
  for (const project of projects) {
    if (token?.isCancellationRequested) {
      break;
    }
    try {
      if (op === "uninstall") {
        await ops.remove(project.fsPath, id);
        await ops.restore(project.fsPath);
      } else {
        await ops.add(project.fsPath, id, version);
      }
      results.push({ project: project.name, ok: true });
    } catch (err) {
      results.push({ project: project.name, ok: false, error: messageOf(err) });
    }
    onProgress?.({ done: ++done, total: projects.length, id, project: project.name });
  }
  return results;
}

/**
 * Updates several packages in one go (the "Update all" and "Consolidate" actions). Each entry names
 * a package, the target version, and the projects to move. Packages are processed sequentially so
 * failures stay attributable and the dotnet CLI isn't hammered in parallel.
 *
 * `onProgress` fires once per package so callers can show "package (x/N)"; `token` lets the user
 * cancel — the loop stops before the next package and returns whatever completed so far.
 */
export async function applyUpdatesWith(
  ops: PackageOps,
  entries: readonly { id: string; version: string; projects: { name: string; fsPath: string }[] }[],
  onProgress?: (progress: ApplyProgress) => void,
  token?: CancelSignal,
): Promise<BatchEntryResult[]> {
  const results: BatchEntryResult[] = [];
  let done = 0;
  for (const entry of entries) {
    if (token?.isCancellationRequested) {
      break;
    }
    results.push({
      id: entry.id,
      results: await applyPackageWith(ops, "update", entry.id, entry.version, entry.projects, undefined, token),
    });
    onProgress?.({ done: ++done, total: entries.length, id: entry.id });
  }
  return results;
}

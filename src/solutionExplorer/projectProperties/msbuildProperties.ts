// Asks MSBuild for a project's evaluated properties, so the panel can tell "not set" from "set by a
// Directory.Build.props or an import" — the distinction that decides whether a field is safe to write.
//
// Two deliberate differences from `queryProjectOutput` in src/debug/projectOutput.ts, which is the
// other caller of `dotnet msbuild -getProperty`:
//
//  - This never throws. The panel has to render, and stay usable, on a machine with no SDK on PATH or
//    with a project that does not restore. A missing answer means "unknown", which the classifier
//    already handles by keeping the field locked.
//  - It has a timeout. A first evaluation can trigger a restore, and a hung one must not leave the
//    panel's fields locked forever with no explanation.

import { execFile } from "node:child_process";
import { EVALUATED_TAGS } from "./propertyCatalog.js";
import { parseGetPropertyOutput } from "../../debug/projectOutput.js";
import { msbuildEnv } from "../../shared/msbuild.js";

/** A solution-wide evaluation easily exceeds execFile's 1 MB default. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** Long enough for a cold evaluation with a restore, short enough that the UI is not stuck. */
const TIMEOUT_MS = 20_000;

export interface QueryOptions {
  /** Required for a multi-targeted project: without it MSBuild evaluates an unspecified framework. */
  framework?: string;
  configuration?: string;
  tags?: readonly string[];
}

export interface EvaluatedProperties {
  values: Record<string, string>;
}

/**
 * Returns the evaluated values, or `undefined` when MSBuild could not be asked or did not answer
 * usably. Properties MSBuild reports as empty are included as empty strings — "evaluated to nothing"
 * is a real answer and means something different from "no answer".
 */
export async function queryProperties(
  projectFsPath: string,
  options: QueryOptions = {},
): Promise<EvaluatedProperties | undefined> {
  const tags = options.tags ?? EVALUATED_TAGS;
  const args = [
    "msbuild",
    projectFsPath,
    ...tags.map((tag) => `-getProperty:${tag}`),
    `-p:Configuration=${options.configuration ?? "Debug"}`,
    "-v:q",
    "--nologo",
  ];
  if (options.framework) {
    args.push(`-p:TargetFramework=${options.framework}`);
  }

  const stdout = await run(args);
  if (stdout === undefined) {
    return undefined;
  }

  const parsed = parseGetPropertyOutput(stdout, tags.length === 1 ? tags[0] : undefined);
  if (!parsed) {
    return undefined;
  }

  const values: Record<string, string> = {};
  for (const tag of tags) {
    if (parsed[tag] !== undefined) {
      values[tag] = parsed[tag].trim();
    }
  }
  return { values };
}

/** Runs `dotnet` and swallows every failure mode into `undefined`. */
function run(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "dotnet",
      args,
      { windowsHide: true, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, env: msbuildEnv() },
      (error, stdout) => {
        // No SDK, a restore error, an evaluation error, or the timeout: all of them mean the panel
        // simply does not learn the evaluated values this time.
        resolve(error ? undefined : stdout);
      },
    );
  });
}

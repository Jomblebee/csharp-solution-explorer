// Pure helpers for the `dotnet test` invocation: building the argv and pulling the test-host PID out
// of its stdout. Kept vscode-free so both are unit-testable (the PID regex is the linchpin of the
// debug-attach flow and must not silently drift).

import type { TestOutputLevel } from "./outputFilter.js";

/**
 * Argv for `dotnet test <target> --logger trx --results-directory <dir>`, adding `-f <framework>`
 * only when a framework is given (single-target projects must not receive a `--framework` flag) and
 * `--filter <expr>` only when a non-empty filter expression is given.
 *
 * `level` controls how chatty the run is. `-v:q` silences the MSBuild half (restore + build spam);
 * because that also mutes the console logger, the logger's verbosity is set explicitly rather than
 * inherited. TRX stays the result source either way — the console logger is purely cosmetic.
 */
export function buildTestArgs(
  targetFsPath: string,
  resultsDir: string,
  framework?: string,
  filter?: string,
  coverage?: boolean,
  level: TestOutputLevel = "full",
): string[] {
  const args = ["test", targetFsPath, "--logger", "trx", "--results-directory", resultsDir, "--nologo"];
  if (level !== "full") {
    args.push("-v:q", "--logger", `console;verbosity=${level === "summary" ? "quiet" : "normal"}`);
  }
  if (framework) {
    args.push("-f", framework);
  }
  if (filter) {
    args.push("--filter", filter);
  }
  if (coverage) {
    // Cross-platform collector; writes coverage.cobertura.xml under resultsDir/<guid>/.
    args.push("--collect", "XPlat Code Coverage");
  }
  return args;
}

/**
 * A VSTest `--filter` expression selecting the given fully-qualified test names, e.g.
 * `FullyQualifiedName=Ns.C.A|FullyQualifiedName=Ns.C.B`. Returns undefined for an empty selection
 * (run everything). Data-driven suffixes like `(x: 1)` are stripped — VSTest matches on the method's
 * FQN, not the display name.
 */
export function buildFqnFilter(fqns: string[]): string | undefined {
  const clauses = fqns
    .map((fqn) => fqn.replace(/\(.*\)$/, "").trim())
    .filter((fqn) => fqn.length > 0)
    .map((fqn) => `FullyQualifiedName=${fqn}`);
  return clauses.length > 0 ? clauses.join("|") : undefined;
}

/**
 * Extracts the test-host PID from a line like `Process Id: 12345, Name: testhost`, which
 * `dotnet test` prints (with `VSTEST_HOST_DEBUG=1`) right before the host spins waiting for a
 * debugger. Returns `undefined` for any other line.
 */
export function parseTestHostPid(line: string): number | undefined {
  const match = /Process Id:\s*(\d+)/.exec(line);
  return match ? Number(match[1]) : undefined;
}

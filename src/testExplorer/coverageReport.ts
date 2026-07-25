// Bridges parsed Cobertura data (coberturaParser.ts) to VS Code's test-coverage API. Accumulates the
// per-file line hits of a run — each project in the run contributes its own report — and publishes
// one FileCoverage per file at the end, so the run profile's `loadDetailedCoverage` callback can
// serve the line detail lazily afterwards.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mergeLineHits, parseCobertura, type FileCoverageData, type LineHit } from "./coberturaParser.js";

export class CoverageStore {
  /**
   * Per run: uri.toString() → merged line hits. Keyed by the run object in a WeakMap, so a finished
   * run's data disappears with it instead of accumulating for the life of the extension host, and
   * two runs covering the same file cannot overwrite each other's numbers.
   */
  private readonly byRun = new WeakMap<vscode.TestRun, Map<string, LineHit[]>>();

  /** Accumulates one project's report into the run, merging per file. Publishes nothing yet. */
  add(run: vscode.TestRun, data: FileCoverageData[], resolveDir: string): void {
    let files = this.byRun.get(run);
    if (!files) {
      files = new Map<string, LineHit[]>();
      this.byRun.set(run, files);
    }
    for (const file of data) {
      const key = toUri(file.file, resolveDir).toString();
      files.set(key, mergeLineHits(files.get(key) ?? [], file.lines));
    }
  }

  /**
   * Publishes the run's accumulated coverage, one FileCoverage per file. Called once all projects
   * have reported: `addCoverage` gives no guarantee about a second call for the same uri, and only
   * the merged totals are meaningful anyway.
   */
  publish(run: vscode.TestRun): void {
    for (const [key, lines] of this.byRun.get(run) ?? []) {
      run.addCoverage(vscode.FileCoverage.fromDetails(vscode.Uri.parse(key), lines.map(toStatement)));
    }
  }

  /** The line detail for a published FileCoverage of `run` (empty if unknown). */
  detailsFor(run: vscode.TestRun, fileCoverage: vscode.FileCoverage): vscode.FileCoverageDetail[] {
    const lines = this.byRun.get(run)?.get(fileCoverage.uri.toString()) ?? [];
    return lines.map(toStatement);
  }
}

function toStatement(line: LineHit): vscode.StatementCoverage {
  return new vscode.StatementCoverage(line.hits, new vscode.Position(Math.max(line.line - 1, 0), 0));
}

/** Cobertura writes absolute paths from coverlet, but resolve project-relative ones just in case. */
function toUri(file: string, resolveDir: string): vscode.Uri {
  return vscode.Uri.file(path.isAbsolute(file) ? file : path.resolve(resolveDir, file));
}

/**
 * Reads and parses every `*.cobertura.xml` under `dir` (recursively). VSTest's XPlat collector nests
 * the file one guid-named directory deep; MTP writes to a path we chose. Fails open to `[]`.
 */
export async function readCoverageReports(dir: string): Promise<FileCoverageData[]> {
  const files = await findCoberturaFiles(dir);
  const all: FileCoverageData[] = [];
  for (const file of files) {
    try {
      all.push(...parseCobertura(await fs.readFile(file, "utf8")));
    } catch {
      /* skip an unreadable report */
    }
  }
  return all;
}

async function findCoberturaFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findCoberturaFiles(full)));
    } else if (entry.name.toLowerCase().endsWith(".cobertura.xml")) {
      found.push(full);
    }
  }
  return found;
}

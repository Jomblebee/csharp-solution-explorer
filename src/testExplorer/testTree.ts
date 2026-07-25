// Groups the flat TRX result list into a project > class > method shape and assigns each node a
// stable id. Stable ids matter: the TestController re-uses them across runs so VS Code updates the
// existing tree items in place (green/red) instead of duplicating them. Pure and vscode-free.

import type { TrxTestResult } from "./trxParser.js";

export interface MethodNode {
  id: string;
  method: string;
  result: TrxTestResult;
}

export interface ClassNode {
  id: string;
  className: string;
  methods: MethodNode[];
}

/**
 * Stable ids for a class / method item. Kept as standalone helpers so discovery, live reporting and
 * the batch `groupByClass` path all derive identical ids — the TestController relies on id equality
 * to update an existing item in place rather than duplicating it.
 */
export function classIdFor(projectFsPath: string, className: string): string {
  return `${projectFsPath}::${className}`;
}

export function methodIdFor(projectFsPath: string, className: string, method: string): string {
  return `${classIdFor(projectFsPath, className)}::${method}`;
}

/**
 * Buckets results by their `className`, preserving first-seen order for classes and methods. The id
 * scheme embeds the project path so items from different projects never collide, and embeds the
 * display method name so data-driven rows (`Adds(a: 1)` / `Adds(a: 2)`) get distinct method items.
 * A duplicate `class::method` id keeps the last result — the newest outcome wins.
 */
export function groupByClass(projectFsPath: string, results: TrxTestResult[]): ClassNode[] {
  const classes = new Map<string, ClassNode>();
  const methodsById = new Map<string, MethodNode>();

  for (const result of results) {
    const classId = classIdFor(projectFsPath, result.className);
    let classNode = classes.get(classId);
    if (!classNode) {
      classNode = { id: classId, className: result.className, methods: [] };
      classes.set(classId, classNode);
    }

    const methodId = methodIdFor(projectFsPath, result.className, result.method);
    const existing = methodsById.get(methodId);
    if (existing) {
      existing.result = result;
      continue;
    }
    const methodNode: MethodNode = { id: methodId, method: result.method, result };
    methodsById.set(methodId, methodNode);
    classNode.methods.push(methodNode);
  }

  return [...classes.values()];
}

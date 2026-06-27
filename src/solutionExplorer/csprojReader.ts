import * as path from "node:path";

export function isLikelyCsproj(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".csproj";
}

export function getProjectRootDir(csprojPath: string): string {
  return path.dirname(csprojPath);
}

import { SolutionTreeNode } from "./slnParser.js";
import { addNestedProjectRelation, removeNestedProjectRelation } from "./slnWriter.js";

/**
 * Moves a project (by GUID) into the given target solution folder, or to the solution
 * root when `targetFolderGuid` is `null`. Operates on .sln text only (the nesting lives
 * in `GlobalSection(NestedProjects)`).
 */
export function moveProjectToFolder(slnText: string, projectGuid: string, targetFolderGuid: string | null): string {
  let result = removeNestedProjectRelation(slnText, projectGuid);
  if (targetFolderGuid) {
    result = addNestedProjectRelation(result, projectGuid, targetFolderGuid);
  }
  return result;
}

/** Adds the GUID of a solution folder node and all of its descendant solution folders to `guids`. */
export function collectDescendantFolderGuids(node: SolutionTreeNode, guids: Set<string>): void {
  if (node.kind === "solutionFolder") {
    guids.add(node.guid);
    for (const child of node.children) {
      collectDescendantFolderGuids(child, guids);
    }
  }
}

/**
 * Moves a solution folder (by GUID) into the given target solution folder, or to the
 * solution root when `targetFolderGuid` is `null`. Throws when the move would create a
 * cycle (target is the folder itself or one of its descendants). `folderChildren` are the
 * folder's direct children, used to determine its descendants.
 */
export function moveSolutionFolderInto(
  slnText: string,
  folderGuid: string,
  folderChildren: SolutionTreeNode[],
  targetFolderGuid: string | null,
): string {
  if (targetFolderGuid) {
    const excluded = new Set<string>([folderGuid]);
    for (const child of folderChildren) {
      collectDescendantFolderGuids(child, excluded);
    }
    if (excluded.has(targetFolderGuid)) {
      throw new Error("Cannot move a solution folder into itself or one of its descendants.");
    }
  }

  let result = removeNestedProjectRelation(slnText, folderGuid);
  if (targetFolderGuid) {
    result = addNestedProjectRelation(result, folderGuid, targetFolderGuid);
  }
  return result;
}

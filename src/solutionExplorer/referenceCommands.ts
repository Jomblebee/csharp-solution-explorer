import * as path from "node:path";
import * as vscode from "vscode";
import { basenameWithoutExtension, SolutionTreeDataProvider } from "./solutionTreeDataProvider.js";
import { parseProjectReferences } from "./csprojReader.js";
import {
  addProjectReference as addProjectReferenceToCsproj,
  removeProjectReference as removeProjectReferenceFromCsproj,
} from "./csprojWriter.js";
import { ProjectReferenceTreeItem } from "./treeItems.js";
import { resolveOwningProjectUri, toPosixRelative } from "./commandUtils.js";

export async function addProjectReference(item: unknown, provider: SolutionTreeDataProvider): Promise<void> {
  const ownerUri = resolveOwningProjectUri(item);
  if (!ownerUri) {
    return;
  }
  const ownerDir = path.dirname(ownerUri.fsPath);
  const ownerText = new TextDecoder().decode(await vscode.workspace.fs.readFile(ownerUri));
  const alreadyReferenced = new Set(
    parseProjectReferences(ownerText).map((ref) => path.resolve(ownerDir, ref.relativePath).toLowerCase()),
  );

  const candidateUris = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/{bin,obj,node_modules,.git,.vs}/**",
  );
  const candidates = candidateUris
    .filter((uri) => uri.fsPath.toLowerCase() !== ownerUri.fsPath.toLowerCase())
    .filter((uri) => !alreadyReferenced.has(uri.fsPath.toLowerCase()))
    .sort((a, b) => basenameWithoutExtension(a.fsPath).localeCompare(basenameWithoutExtension(b.fsPath)));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage("No other projects are available to reference.");
    return;
  }

  const picks = await vscode.window.showQuickPick(
    candidates.map((uri) => ({
      label: basenameWithoutExtension(uri.fsPath),
      description: toPosixRelative(ownerDir, uri.fsPath),
      uri,
    })),
    { canPickMany: true, placeHolder: "Select projects to reference" },
  );
  if (!picks || picks.length === 0) {
    return;
  }

  let updated = ownerText;
  for (const pick of picks) {
    // Write the include in Windows-style backslash form, matching Visual Studio and the samples.
    const includePath = path.relative(ownerDir, pick.uri.fsPath).split(path.sep).join("\\");
    updated = addProjectReferenceToCsproj(updated, includePath);
  }

  await vscode.workspace.fs.writeFile(ownerUri, new TextEncoder().encode(updated));
  provider.refresh();
}

export async function removeProjectReference(
  item: ProjectReferenceTreeItem,
  provider: SolutionTreeDataProvider,
): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Remove the reference to '${item.info.name}'? The referenced project's files are kept on disk.`,
    { modal: true },
    "Remove",
  );
  if (confirmation !== "Remove") {
    return;
  }

  const ownerUri = item.info.ownerUri;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(ownerUri));
  const updated = removeProjectReferenceFromCsproj(text, item.info.includePath);

  await vscode.workspace.fs.writeFile(ownerUri, new TextEncoder().encode(updated));
  provider.refresh();
}

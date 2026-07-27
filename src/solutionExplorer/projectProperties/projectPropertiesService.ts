// The only module in the Project Properties feature that touches the filesystem or the vscode API —
// the same role launchSettingsIo.ts plays for launch profiles. Everything it decides with comes from
// the pure scanner, writer and classifier.
//
// Writes go through a WorkspaceEdit whenever the project file is open in an editor, and through
// `workspace.fs` only when it is not. This is a deliberate departure from the rest of the extension
// (referenceCommands.ts writes the whole file unconditionally): people open a .csproj to look at it and
// then use the panel, and a plain `fs.writeFile` would silently discard whatever they had typed. Going
// through the edit API also puts the panel's change on the editor's undo stack, which is what a user
// expects from something that edited their file.

import * as vscode from "vscode";
import * as path from "node:path";
import { errorText } from "../../shared/errorText.js";
import { ancestorDirectories } from "../../nuget/centralPackageManagement.js";
import { isWebSdk, parseSdkAttribute, parseTargetFrameworks } from "../parsers/csprojReader.js";
import { getLaunchSettingsPath } from "../parsers/launchSettingsReader.js";
import { diffRange } from "../parsers/xmlTextLines.js";
import { readDeclaration } from "../parsers/csprojPropertyScanner.js";
import {
  isRefusal,
  removeProperty,
  setProperty,
  setTargetFrameworks,
  type CsprojWriteResult,
} from "../parsers/csprojPropertyWriter.js";
import {
  EVALUATED_TAGS,
  FRAMEWORKS_TAG,
  PROPERTY_CATALOG,
  sdkDefaultFor,
  type PropertyDefinition,
} from "./propertyCatalog.js";
import { classifyProperty, type AncestorDeclaration, type PropertyStatus } from "./propertyClassification.js";
import { queryProperties } from "./msbuildProperties.js";

const DIRECTORY_BUILD_PROPS = "Directory.Build.props";

/** Frameworks a project can actually be evaluated and run against, as elsewhere in the extension. */
const RUNNABLE_FRAMEWORK_PATTERN = /^net\d+\.\d+$/i;

export interface ProjectSummary {
  name: string;
  fsPath: string;
  sdk?: string;
  isWeb: boolean;
}

export interface ProjectPropertiesState {
  project: ProjectSummary;
  properties: PropertyStatus[];
  frameworks: string[];
  selectedFramework?: string;
  hasLaunchSettings: boolean;
  /** Ancestor Directory.Build.props found on disk, nearest first — for the "inherited from" links. */
  inheritedFiles: string[];
}

/** An ancestor Directory.Build.props, read once per state build. */
interface AncestorPropsFile {
  fsPath: string;
  text: string;
}

export interface WriteReport {
  tag: string;
  outcome: CsprojWriteResult["outcome"] | "refusedNotEditable";
  message?: string;
  blockingConditions?: string[];
  line?: number;
}

export class ProjectPropertiesService {
  /** Keyed by `${framework}|${configuration}`; dropped whenever the project file changes. */
  private readonly evaluationCache = new Map<string, Record<string, string>>();
  /** The text this service last wrote, so its own watcher event is not mistaken for an outside edit. */
  private lastWrittenText: string | undefined;
  /** The framework the panel is showing — the one every evaluation and cache lookup uses. */
  private framework: string | undefined;

  constructor(readonly projectUri: vscode.Uri) {}

  get projectFsPath(): string {
    return this.projectUri.fsPath;
  }

  /**
   * Builds the panel's state from the filesystem alone — no MSBuild, so it is fast enough to render
   * immediately. Evaluated values arrive later through `evaluate`.
   */
  async read(selectedFramework?: string): Promise<ProjectPropertiesState> {
    const text = await this.readProjectText();
    const sdk = parseSdkAttribute(text);
    const frameworks = parseTargetFrameworks(text).filter((framework) =>
      RUNNABLE_FRAMEWORK_PATTERN.test(framework),
    );
    // A single-targeted project needs no `-p:TargetFramework`, so its evaluation is keyed on "".
    this.framework = selectedFramework ?? (frameworks.length > 1 ? frameworks[0] : undefined);
    const ancestors = await this.readAncestorProps();
    const evaluated = this.evaluationCache.get(cacheKey(this.framework));

    return {
      project: {
        name: path.basename(this.projectFsPath, path.extname(this.projectFsPath)),
        fsPath: this.projectFsPath,
        sdk,
        isWeb: isWebSdk(sdk),
      },
      properties: this.classifyAll(text, sdk, ancestors, evaluated),
      frameworks,
      selectedFramework: this.framework ?? frameworks[0],
      hasLaunchSettings: await this.hasLaunchSettings(),
      inheritedFiles: ancestors.map((ancestor) => ancestor.fsPath),
    };
  }

  /**
   * Asks MSBuild for the evaluated properties and re-classifies with them. Returns `undefined` when
   * MSBuild could not be reached, which leaves undeclared fields locked rather than guessing.
   */
  async evaluate(framework = this.framework): Promise<PropertyStatus[] | undefined> {
    this.framework = framework;
    const key = cacheKey(framework);
    let values = this.evaluationCache.get(key);
    if (!values) {
      const result = await queryProperties(this.projectFsPath, { framework, tags: EVALUATED_TAGS });
      if (!result) {
        return undefined;
      }
      values = result.values;
      this.evaluationCache.set(key, values);
    }

    const text = await this.readProjectText();
    const sdk = parseSdkAttribute(text);
    return this.classifyAll(text, sdk, await this.readAncestorProps(), values);
  }

  /** Writes `value`, refusing anything the freshly-read file says is not editable. */
  async writeProperty(tag: string, value: string, mode: "set" | "override" = "set"): Promise<WriteReport> {
    return this.write(tag, (text) =>
      tag === FRAMEWORKS_TAG
        ? setTargetFrameworks(text, splitFrameworks(value))
        : setProperty(text, tag, value, { insertOnly: mode === "override" }),
      mode,
    );
  }

  /**
   * Removes the project's own declaration. Note this restores whatever the *imports* say, which is not
   * necessarily the SDK default — the caller re-evaluates afterwards and shows what the value became.
   */
  async clearProperty(tag: string): Promise<WriteReport> {
    if (tag === FRAMEWORKS_TAG) {
      return { tag, outcome: "refusedNotEditable", message: "A project must declare a target framework." };
    }
    return this.write(tag, (text) => removeProperty(text, tag), "set");
  }

  /** Called by the panel's watcher: true when the change on disk is not the one we just made. */
  isForeignChange(text: string): boolean {
    return text !== this.lastWrittenText;
  }

  invalidateEvaluation(): void {
    this.evaluationCache.clear();
  }

  private async write(
    tag: string,
    edit: (text: string) => CsprojWriteResult,
    mode: "set" | "override",
  ): Promise<WriteReport> {
    const text = await this.readProjectText();

    // Re-check against the file as it is right now. The webview's copy of `editable` can be stale —
    // the project file may have gained a Condition, or a Directory.Build.props may have appeared,
    // since the panel last rendered.
    const guard = await this.checkEditable(text, tag, mode);
    if (guard) {
      return guard;
    }

    const result = edit(text);
    if (isRefusal(result.outcome)) {
      return {
        tag,
        outcome: result.outcome,
        message: describeRefusal(result),
        blockingConditions: result.blockingConditions,
        line: result.line,
      };
    }
    if (result.outcome === "unchanged") {
      return { tag, outcome: "unchanged", line: result.line };
    }

    try {
      await this.writeProjectText(text, result.text);
    } catch (err) {
      return { tag, outcome: "refusedNotEditable", message: errorText(err) };
    }
    this.invalidateEvaluation();
    return { tag, outcome: result.outcome, line: result.line };
  }

  /** Blocks a write the classifier would not have offered — with the classifier's own explanation. */
  private async checkEditable(text: string, tag: string, mode: "set" | "override"): Promise<WriteReport | undefined> {
    const definition = PROPERTY_CATALOG.find((entry) => entry.tag === tag);
    if (!definition) {
      return { tag, outcome: "refusedNotEditable", message: `${tag} is not an editable project property.` };
    }
    // The frameworks pair is checked by setTargetFrameworks itself, atomically across both tags.
    if (definition.editor === "frameworks") {
      return undefined;
    }

    const declaration = readDeclaration(text, tag);
    // An override introduces a local declaration where there is none — the whole point is that the
    // value is currently inherited, so the classifier's "not editable" is expected here.
    if (mode === "override") {
      return declaration.state === "none"
        ? undefined
        : {
            tag,
            outcome: "refusedNotEditable",
            message: `${tag} is already declared in this project.`,
          };
    }

    const status = classifyProperty({
      definition,
      declaration,
      ancestors: ancestorsFor(await this.readAncestorProps(), tag),
      evaluated: this.evaluationCache.get(cacheKey(this.framework))?.[tag],
      sdkDefault: sdkDefaultFor(definition, parseSdkAttribute(text)),
    });
    return status.editable ? undefined : { tag, outcome: "refusedNotEditable", message: status.note, line: status.declaredLine };
  }

  private classifyAll(
    text: string,
    sdk: string | undefined,
    ancestors: readonly AncestorPropsFile[],
    evaluated: Record<string, string> | undefined,
  ): PropertyStatus[] {
    return PROPERTY_CATALOG.map((definition) =>
      definition.editor === "frameworks"
        ? this.classifyFrameworks(definition, text, ancestors, evaluated)
        : classifyProperty({
            definition,
            declaration: readDeclaration(text, definition.tag),
            ancestors: ancestorsFor(ancestors, definition.tag),
            evaluated: evaluated?.[definition.tag],
            sdkDefault: sdkDefaultFor(definition, sdk),
          }),
    );
  }

  /**
   * The frameworks field stands for two tags. Whichever the project declares is the one that decides
   * the field's origin — declaring both is a state MSBuild itself resolves by ignoring the singular
   * one, and the writer never produces it.
   */
  private classifyFrameworks(
    definition: PropertyDefinition,
    text: string,
    ancestors: readonly AncestorPropsFile[],
    evaluated: Record<string, string> | undefined,
  ): PropertyStatus {
    const plural = readDeclaration(text, "TargetFrameworks");
    const singular = readDeclaration(text, "TargetFramework");
    const declaration = plural.state === "none" ? singular : plural;
    const evaluatedValue = evaluated?.TargetFrameworks || evaluated?.TargetFramework;

    const status = classifyProperty({
      definition,
      declaration,
      ancestors: [
        ...ancestorsFor(ancestors, "TargetFrameworks"),
        ...ancestorsFor(ancestors, "TargetFramework"),
      ],
      evaluated: evaluatedValue,
    });
    return { ...status, tag: FRAMEWORKS_TAG };
  }

  /**
   * Reads the project file — from the open editor when there is one, so unsaved edits are what the
   * panel reasons about, and so a write never resurrects an older version from disk.
   */
  private async readProjectText(): Promise<string> {
    const open = this.openDocument();
    if (open) {
      return open.getText();
    }
    const bytes = await vscode.workspace.fs.readFile(this.projectUri);
    return new TextDecoder().decode(bytes);
  }

  private async writeProjectText(before: string, after: string): Promise<void> {
    this.lastWrittenText = after;
    const document = this.openDocument();
    if (!document) {
      await vscode.workspace.fs.writeFile(this.projectUri, new TextEncoder().encode(after));
      return;
    }

    const change = diffRange(before, after);
    if (!change) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.projectUri,
      new vscode.Range(document.positionAt(change.range.start), document.positionAt(change.range.end)),
      change.replacement,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Could not apply the change to ${path.basename(this.projectFsPath)}.`);
    }
    // The document is left dirty on purpose: the change is the user's to save, alongside whatever else
    // they were editing, and saving here could commit edits they had not finished.
  }

  private openDocument(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((document) => document.uri.fsPath === this.projectFsPath);
  }

  /**
   * Ancestor `Directory.Build.props` files, nearest first.
   *
   * MSBuild imports only the nearest one, but the widespread `GetPathOfFileAbove` chaining means a
   * value can come from further up. Collecting all of them and letting the classifier take the first
   * that declares the property matches both layouts closely enough to name a file and a line, which is
   * what the user needs in order to go and look.
   */
  private async readAncestorProps(): Promise<AncestorPropsFile[]> {
    const found: AncestorPropsFile[] = [];
    for (const directory of ancestorDirectories(path.dirname(this.projectFsPath))) {
      const candidate = path.join(directory, DIRECTORY_BUILD_PROPS);
      const text = await this.tryReadFile(vscode.Uri.file(candidate));
      if (text !== undefined) {
        found.push({ fsPath: candidate, text });
      }
    }
    // Not cached: a handful of small reads, and the files change under us while the panel is open.
    return found;
  }

  private async tryReadFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  private async hasLaunchSettings(): Promise<boolean> {
    const settingsPath = getLaunchSettingsPath(path.dirname(this.projectFsPath));
    return (await this.tryReadFile(vscode.Uri.file(settingsPath))) !== undefined;
  }
}

/** Picks each ancestor file's declaration of `tag`, keeping the nearest-first order. */
function ancestorsFor(files: readonly AncestorPropsFile[], tag: string): AncestorDeclaration[] {
  return files.map((file) => ({ fsPath: file.fsPath, declaration: readDeclaration(file.text, tag) }));
}

function cacheKey(framework: string | undefined): string {
  return `${framework ?? ""}|Debug`;
}

function splitFrameworks(value: string): string[] {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function describeRefusal(result: CsprojWriteResult): string {
  switch (result.outcome) {
    case "refusedConditioned":
      return `The property is declared under a condition${
        result.blockingConditions?.length ? ` (${result.blockingConditions.join(", ")})` : ""
      }. Edit the project file directly.`;
    case "refusedMultiLine":
      return "The value spans several lines or uses CDATA. Edit the project file directly.";
    case "refusedInvalidValue":
      return "That value cannot be written to a project file.";
    case "refusedMalformed":
      return "The project file's markup could not be read safely. Edit it directly.";
    default:
      return "The change was not applied.";
  }
}

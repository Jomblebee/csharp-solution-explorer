// Decides, per property, where its value comes from and whether the panel may write it into *this*
// project file.
//
// The whole point of the feature hinges on this: a repository that sets `Nullable` or `NoWarn` in a
// shared `Directory.Build.props` must not have that quietly overridden per project because a panel
// rendered an editable text box. So editability follows one rule:
//
//   A *declared* property is editable without asking MSBuild — we can see it in this file.
//   An *undeclared* one is not, until its provenance is known.
//
// Undeclared fields therefore start locked, with a reason, and unlock once the evidence arrives (a
// `Directory.Build.props` read from disk, or an MSBuild evaluation). Inherited values are never
// silently writable — they offer an explicit "override in this project" instead, which is what Visual
// Studio does and what keeps the panel from being a dead end.
//
// Pure — no vscode, no fs, no process.

import type { Declaration } from "../parsers/csprojPropertyScanner.js";
import type { PropertyDefinition } from "./propertyCatalog.js";

export type PropertyOrigin =
  /** Declared unconditionally in this project file. */
  | "declared"
  /** Declared, but under a condition this writer will not touch. */
  | "conditioned"
  /** Comes from a Directory.Build.props or an import. */
  | "inherited"
  /** Not set anywhere; the SDK's default applies. */
  | "default"
  /** Not declared here, and nothing has told us where it comes from yet. */
  | "unknown";

export interface AncestorDeclaration {
  fsPath: string;
  declaration: Declaration;
}

export interface PropertyStatus {
  tag: string;
  origin: PropertyOrigin;
  /** What the editor field shows: the declared text, or the effective value for read-only origins. */
  value: string;
  /** Whether the panel may write this tag into this project file right now. */
  editable: boolean;
  /** Why it is not editable, or where the value comes from. Shown next to the field. */
  note?: string;
  /** For `conditioned`: the conditions in the way, verbatim. */
  conditions?: string[];
  declaredLine?: number;
  inheritedFrom?: { fsPath: string; line?: number };
  /** MSBuild's expansion, shown as a hint when the declared text contains `$(…)`. */
  evaluated?: string;
  /** Several unconditional declarations exist; the last one is the effective one. */
  duplicateLines?: number[];
  /** Offering "override in this project" makes sense for inherited and default values. */
  canOverride: boolean;
}

export interface ClassifyArgs {
  definition: PropertyDefinition;
  /** What this project file declares. */
  declaration: Declaration;
  /** Ancestor `Directory.Build.props` declarations, nearest directory first. */
  ancestors?: AncestorDeclaration[];
  /** MSBuild's evaluated value. `undefined` means it has not answered (yet, or at all). */
  evaluated?: string;
  /** The SDK's default for this property, from `sdkDefaultFor`. */
  sdkDefault?: string;
}

export function classifyProperty(args: ClassifyArgs): PropertyStatus {
  const { definition, declaration, evaluated } = args;
  const base = { tag: definition.tag, evaluated };

  switch (declaration.state) {
    case "declared":
      return {
        ...base,
        origin: "declared",
        // The declared text, not the evaluated one: editing must round-trip `$(NoWarn);NU1903` rather
        // than replace it with whatever it expanded to.
        value: declaration.value,
        editable: true,
        declaredLine: declaration.line,
        duplicateLines: declaration.duplicateLines,
        note:
          declaration.duplicateLines && declaration.duplicateLines.length > 1
            ? `Declared ${declaration.duplicateLines.length} times in this project — the last one wins.`
            : undefined,
        canOverride: false,
      };

    case "conditioned":
      return {
        ...base,
        origin: "conditioned",
        value: evaluated ?? "",
        editable: false,
        conditions: declaration.conditions,
        declaredLine: declaration.lines[0],
        note: "Declared under a condition. Edit the project file directly.",
        canOverride: false,
      };

    case "unwritable":
      return {
        ...base,
        origin: "conditioned",
        value: evaluated ?? "",
        editable: false,
        declaredLine: declaration.line,
        note: unwritableNote(declaration.reason),
        canOverride: false,
      };

    case "none":
      return classifyUndeclared(args, base);
  }
}

function classifyUndeclared(
  args: ClassifyArgs,
  base: { tag: string; evaluated?: string },
): PropertyStatus {
  const { evaluated, sdkDefault } = args;

  const ancestor = (args.ancestors ?? []).find((entry) => entry.declaration.state !== "none");
  if (ancestor) {
    const declaration = ancestor.declaration;
    return {
      ...base,
      origin: "inherited",
      value: evaluated ?? (declaration.state === "declared" ? declaration.value : ""),
      editable: false,
      inheritedFrom: { fsPath: ancestor.fsPath, line: declaredLineOf(declaration) },
      note: `Inherited from ${fileName(ancestor.fsPath)}.`,
      canOverride: true,
    };
  }

  if (evaluated === undefined) {
    // Fail closed. Writing a property whose provenance is unknown is exactly how a shared build
    // configuration gets silently overridden.
    return {
      ...base,
      origin: "unknown",
      value: "",
      editable: false,
      note: "Not verified — MSBuild has not reported this project's evaluated properties.",
      canOverride: true,
    };
  }

  // "Inherited" needs positive evidence, and a non-empty evaluation is not it. The SDK computes plenty
  // of values on its own — LangVersion from the target framework, AssemblyName and RootNamespace and
  // PackageId from the project's file name — and treating those as imported would lock fields that are
  // perfectly safe to edit. So the claim is only made when the value contradicts a default we know
  // (see the ancestor branch above for the case where we can name the file).
  const effective = evaluated.trim();
  if (effective !== "" && sdkDefault !== undefined && !equalsIgnoreCase(effective, sdkDefault)) {
    return {
      ...base,
      origin: "inherited",
      value: effective,
      editable: false,
      note: "Set by an imported file rather than by this project.",
      canOverride: true,
    };
  }

  return {
    ...base,
    origin: "default",
    value: effective,
    editable: true,
    note:
      effective !== ""
        ? `Not set here — the SDK resolves it to \`${effective}\`.`
        : "Not set.",
    canOverride: false,
  };
}

function unwritableNote(reason: "multiLine" | "cdata" | "unexpectedLocation"): string {
  switch (reason) {
    case "multiLine":
      return "The value spans several lines. Edit the project file directly.";
    case "cdata":
      return "The value is wrapped in CDATA. Edit the project file directly.";
    case "unexpectedLocation":
      return "The property sits outside a <PropertyGroup>. Edit the project file directly.";
  }
}

function declaredLineOf(declaration: Declaration): number | undefined {
  switch (declaration.state) {
    case "declared":
      return declaration.line;
    case "unwritable":
      return declaration.line;
    case "conditioned":
      return declaration.lines[0];
    case "none":
      return undefined;
  }
}

function fileName(fsPath: string): string {
  return fsPath.split(/[\\/]/).pop() ?? fsPath;
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

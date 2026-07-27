// The properties the Project Properties panel offers, and how to render each one.
//
// A fixed catalogue rather than "whatever the csproj happens to contain": a project file can hold
// hundreds of MSBuild properties, most of them set by the SDK and not meaningful to edit by hand. This
// is the set Visual Studio's own project pages expose, which is also the set where a wrong value has an
// obvious, explainable effect.
//
// Pure — no vscode.

export type PropertySection = "general" | "build" | "package";

export type PropertyEditorKind =
  /** Free text. */
  | "text"
  /** One of `values`. */
  | "enum"
  /** MSBuild's `true`/`false` strings, rendered as a switch. */
  | "boolean"
  /** The TargetFramework / TargetFrameworks pair, edited as a list. */
  | "frameworks";

export interface PropertyDefinition {
  /** The MSBuild property name, spelled as it should be written. */
  tag: string;
  label: string;
  section: PropertySection;
  editor: PropertyEditorKind;
  values?: string[];
  description?: string;
  /** The SDK's value when the project says nothing — used to tell "default" from "inherited". */
  sdkDefault?: string;
  /** Offered as the placeholder rather than as a value, since it is derived, not stored. */
  placeholder?: string;
}

export const PROPERTY_SECTIONS: { id: PropertySection; title: string; description: string }[] = [
  { id: "general", title: "General", description: "Assembly and namespace identity." },
  { id: "build", title: "Build", description: "Target frameworks, language rules and warnings." },
  { id: "package", title: "Package", description: "Metadata written into the NuGet package." },
];

/** The pseudo-tag the frameworks editor reports under; the writer picks the real tag by count. */
export const FRAMEWORKS_TAG = "TargetFrameworks";

export const PROPERTY_CATALOG: PropertyDefinition[] = [
  {
    tag: "AssemblyName",
    label: "Assembly name",
    section: "general",
    editor: "text",
    description: "Name of the produced assembly, without the extension.",
    placeholder: "the project file name",
  },
  {
    tag: "RootNamespace",
    label: "Root namespace",
    section: "general",
    editor: "text",
    description: "Base namespace for new files and for generated code.",
    placeholder: "the project file name",
  },

  {
    tag: FRAMEWORKS_TAG,
    label: "Target framework(s)",
    section: "build",
    editor: "frameworks",
    description:
      "One entry writes <TargetFramework>, several write <TargetFrameworks>. The panel switches the tag for you.",
  },
  {
    tag: "OutputType",
    label: "Output type",
    section: "build",
    editor: "enum",
    values: ["Library", "Exe", "WinExe"],
    description: "Whether the project builds a library or an executable.",
  },
  {
    tag: "LangVersion",
    label: "Language version",
    section: "build",
    editor: "text",
    description: "C# language version, e.g. `latest`, `preview`, or `12.0`.",
    placeholder: "the framework's default",
  },
  {
    tag: "Nullable",
    label: "Nullable",
    section: "build",
    editor: "enum",
    values: ["enable", "disable", "warnings", "annotations"],
    description: "Nullable reference type context for the whole project.",
  },
  {
    tag: "ImplicitUsings",
    label: "Implicit usings",
    section: "build",
    editor: "enum",
    values: ["enable", "disable"],
    description: "Add the SDK's implicit global usings.",
  },
  {
    tag: "TreatWarningsAsErrors",
    label: "Treat warnings as errors",
    section: "build",
    editor: "boolean",
    sdkDefault: "false",
  },
  {
    tag: "NoWarn",
    label: "Suppressed warnings",
    section: "build",
    editor: "text",
    description: "Semicolon-separated warning codes. Prefix with `$(NoWarn);` to keep inherited ones.",
  },

  { tag: "PackageId", label: "Package ID", section: "package", editor: "text", placeholder: "the assembly name" },
  { tag: "Version", label: "Version", section: "package", editor: "text", sdkDefault: "1.0.0" },
  { tag: "Authors", label: "Authors", section: "package", editor: "text" },
  { tag: "Description", label: "Description", section: "package", editor: "text" },
  { tag: "RepositoryUrl", label: "Repository URL", section: "package", editor: "text" },
  {
    tag: "PackageLicenseExpression",
    label: "License expression",
    section: "package",
    editor: "text",
    description: "An SPDX identifier, e.g. `MIT`.",
  },
  {
    tag: "GeneratePackageOnBuild",
    label: "Generate package on build",
    section: "package",
    editor: "boolean",
    sdkDefault: "false",
  },
];

/** The tags to ask MSBuild about — the frameworks pseudo-tag expands to the two real ones. */
export const EVALUATED_TAGS: string[] = [
  ...new Set(
    PROPERTY_CATALOG.flatMap((definition) =>
      definition.editor === "frameworks" ? ["TargetFramework", "TargetFrameworks"] : [definition.tag],
    ),
  ),
];

/**
 * The SDK's default for a property, where it depends on which SDK the project uses. `OutputType` is
 * the one that matters in practice: the same absent property means a library under Microsoft.NET.Sdk
 * and an executable under the Web and Worker SDKs.
 */
export function sdkDefaultFor(definition: PropertyDefinition, sdk: string | undefined): string | undefined {
  if (definition.tag !== "OutputType") {
    return definition.sdkDefault;
  }
  const name = (sdk ?? "").toLowerCase();
  return name.includes(".web") || name.includes(".worker") ? "Exe" : "Library";
}

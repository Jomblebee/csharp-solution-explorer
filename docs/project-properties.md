[← README](../README.md)

# Project Properties

**Properties** on a project node in the Solution Explorer (or **C# Solution Explorer: Properties** in the Command Palette) opens an editor tab with that project's settings — Visual Studio's project pages, without leaving VS Code.

Three sections:

| Section     | Properties                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **General** | `AssemblyName`, `RootNamespace`                                                                                                    |
| **Build**   | `TargetFramework`/`TargetFrameworks`, `OutputType`, `LangVersion`, `Nullable`, `ImplicitUsings`, `TreatWarningsAsErrors`, `NoWarn` |
| **Package** | `PackageId`, `Version`, `Authors`, `Description`, `RepositoryUrl`, `PackageLicenseExpression`, `GeneratePackageOnBuild`            |

plus a **Launch profiles** card over `Properties/launchSettings.json`.

## Where a value comes from

Every property carries a badge, because "what does this project set" and "what does this project *get*" are different questions:

| Badge             | Meaning                                                                                             | Editable                                        |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Declared here** | The project file sets it, unconditionally.                                                          | Yes                                             |
| **Inherited**     | A `Directory.Build.props` or another import sets it.                                                | No — **Override here** adds a local declaration |
| **Default**       | Nothing sets it; the SDK's default applies.                                                         | Yes                                             |
| **Conditional**   | Declared under a `Condition`, inside a `<Target>`, or in a shape text editing cannot safely change. | No — **Show in project file**                   |
| **Not verified**  | Not declared here, and MSBuild has not reported the evaluated value yet.                            | No — **Edit anyway** to declare it              |

The rule behind this: **a property this project declares is editable immediately** — it is visible in the file, so nothing needs to be inferred. A property the project does *not* declare stays locked until its origin is known, because writing it blind is exactly how a repository-wide `Directory.Build.props` gets silently overridden by one project.

That answer comes from `dotnet msbuild -getProperty:`, run in the background when the panel opens. It never runs at startup or while the tree renders. If the SDK is missing or the evaluation fails, the panel says so and the undeclared fields stay locked — declared ones remain fully editable.

**Inherited** values show the file they come from; clicking it opens that file at the line. **Override here** adds a declaration to *this* project with the inherited value, which you can then edit.

## Clearing a value

**Clear** removes this project's declaration. It does not "reset to the SDK default": if a `Directory.Build.props` also sets the property, the inherited value is what comes back. The panel re-evaluates afterwards and shows what the value actually became.

## Target frameworks

One entry writes `<TargetFramework>`, several (separated by `;`) write `<TargetFrameworks>`. The panel switches the tag for you and removes the other one in the same save, so the project never declares both.

A multi-targeted project gets a framework picker in the header. MSBuild evaluates one framework at a time, so the picker decides which one the **Inherited**/**Default** badges describe.

## How the project file is edited

Only the smallest necessary substring is replaced. Indentation, tabs-versus-spaces, attribute spacing, comments — including one on the same line as the property — and the file's line endings all stay exactly as they were. A change to `Nullable` is a one-line diff.

When the `.csproj` is open in an editor, the change is applied as an editor edit rather than a file write. Two consequences, both intentional:

- Unsaved changes in that editor are **not** discarded.
- The panel's change lands on the editor's undo stack, so `Ctrl+Z` in the project file undoes it. It also leaves the document dirty — saving is yours to do, together with whatever else you were editing.

The panel refuses rather than guesses. If a property is under a condition, spans several lines, sits in CDATA, lives outside a `<PropertyGroup>`, or the markup does not parse, no write happens and the panel says why with a link into the file.

## Launch profiles

The card lists every profile in `Properties/launchSettings.json` with its command, arguments, working directory, URLs, browser and `dotnet run` message flags, and environment variables (as `KEY=value` lines).

Adding, renaming, duplicating and deleting go through VS Code's own input box and confirmation dialog, and through the same edit layer as the **Select Launch Profile…** quick pick — which keeps its own guided menu and now offers **Open Project Properties…** as well. Writes round-trip the file: a BOM, the `$schema` key, and any keys the editor does not model (`iisSettings`, `nativeDebugging`, `hotReloadEnabled`, …) all survive unchanged.

If the file changes outside the panel, the panel reloads it.

## Related

- [Settings](settings.md) — the extension's own options, and the **Options** panel
- [Debugging](debugging.md) — how launch profiles are used by F5
- [Dependencies & NuGet](nuget.md) — package references, and the NuGet Package Manager panel

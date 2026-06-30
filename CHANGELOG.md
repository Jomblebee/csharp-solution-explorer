# Changelog

All notable changes to the "csharp-solution-explorer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.7.0] – 2026-06-30

### Added

- **Open in Editor on projects**: right-click a project to open its `.csproj` file in the
  editor — the command sits at the top of the context menu, mirroring the existing
  "Open in Editor" on solution nodes.

### Changed

- A project's own `.csproj` is no longer shown as a child file under the project node.
  Open it via the new **Open in Editor** command instead.

## [0.6.0] – 2026-06-30

### Added

- **New Project…**: right-click a solution or solution folder to scaffold a new project from
  a `dotnet new` template (Console, Class Library, Web API, MVC, Razor Pages, Blazor, Worker,
  and xUnit/NUnit/MSTest test projects). The project is created in a folder next to the
  solution and automatically registered in the `.sln`/`.slnx` file.
- **Rebuild**: forces a full recompile via `dotnet build --no-incremental` on both project
  and solution nodes.
- **Test**: runs `dotnet test` on both project and solution nodes.
- **Build on solutions**: the **Build** command (renamed from "Build Project") now also runs
  on solution nodes, not just projects.

## [0.5.0] – 2026-06-30

### Added

- **Dependencies tree**: each project now shows a `Dependencies` node that groups its
  references into Visual Studio-style categories — `Frameworks`, `Analyzers`, `Packages`,
  and `Projects` (empty categories are hidden). The tree is resolved from
  `project.assets.json` after a restore for full fidelity (including transitive packages),
  falling back to parsing the `.csproj` directly when no restore has run.
- **NuGet package management**: right-click a project, its `Dependencies` node, or the
  `Packages` category to **Add Package…** — a Quick Pick searches nuget.org live as you
  type and a second pick chooses the version. Direct packages gain **Update Package…** and
  **Remove Package**. Writes go through the `dotnet` CLI so versions resolve and a restore
  keeps the tree (including transitive packages) in sync.
- **Outdated package indicator**: direct packages with a newer stable version on nuget.org
  are flagged as `installed → latest` (highlighted) with a one-click **Update to Latest
  Version** action, alongside the regular Update/Remove. Version lookups run when the
  `Packages` node is expanded, are cached for the session, and can be disabled via the new
  `csharpSolutionExplorer.nuget.checkForUpdates` setting.
- **Project references**: **Add Project Reference…** (on a project, its `Dependencies` node,
  or the `Projects` category) lets you pick one or more other projects to reference;
  **Remove** drops a direct reference. Each reference is expandable to reveal the referenced
  project's own references — fully recursive, dimmed, with cycle protection.
- **Restore / Clean**: `dotnet restore` and `dotnet clean` are available as context commands
  on both project and solution nodes, running in a dedicated terminal like Build/Run.

## [0.4.0] – 2026-06-30

### Added

- Companion files are now nested under their `.razor` file in the tree, just like Visual Studio.
  Any sibling named `Foo.razor.*` (e.g. `Foo.razor.cs`, `Foo.razor.css`, `Foo.razor.js`) appears
  as a child of `Foo.razor`. The Razor node shows a collapse arrow; clicking it reveals the
  companions. `.razor` files without companions, and unpaired `*.razor.*` files (no matching
  `.razor`), continue to appear as normal flat nodes.

## [0.3.0] – 2026-06-30

### Added

- Solution folders with path-like names (e.g. `src/base/MyLib`) are now automatically
  displayed as a proper nested folder hierarchy in the tree view. Virtual path-segment
  nodes are expanded by default and have no context-menu actions; real leaf folders retain
  their full rename/delete/move context menu.

## [0.2.0] – 2026-06-29

### Added

- **New Item submenu** with five new commands: New Record…, New Enum…, New Struct…, New Razor Component…, New File…
- All C# and Razor templates are fully configurable via VS Code settings (`csharpSolutionExplorer.templates.*`)
- Template variables: `${namespace}`, `${name}`, `${filename}`, `${date}`, `${cursor}` (sets initial cursor position)
- Razor component name validation enforces the Blazor convention (must start with an uppercase letter)
- Refactored New Class and New Interface to use the same template engine (both now support `${cursor}` and all template variables)

## [0.1.1] – 2026-06-28

### Fixed

- Delete Solution Folder: warning text now accurately states that contained
  projects are removed from the solution (not moved to parent level)
- Add Existing Project: file picker now correctly accepts .fsproj and .vbproj
  in addition to .csproj

## [0.1.0] – 2026-06-28

### Added

- Initial Solution Explorer view in a dedicated Activity Bar container.
- `.sln` and `.slnx` parsing to discover referenced C# projects and Solution Folders.
- Disk-based Folders/Files tree under each project.
- Refresh command and view-title refresh button.
- Click-to-open for file nodes.
- FileSystemWatcher-based automatic tree refresh.
- Multi-root workspace support, with loose top-level `.csproj` fallback when no `.sln` is present.
- New Class command: prompts for a class name, derives a namespace from the project and folder structure, and creates a `.cs` file.
- New Interface command: same as New Class but creates an interface stub.
- New Folder command: creates a folder inside a project or existing folder.
- New Solution Folder command: adds a Solution Folder entry to `.sln` / `.slnx`.
- Rename command: renames files, folders, projects, and Solution Folders (project rename also updates the `.sln`/`.slnx` entry and root folder).
- Delete command: deletes files and folders to trash; deletes a project's root folder to trash and removes its entry from the solution file.
- Add Existing Project command: picks a `.csproj`/`.fsproj`/`.vbproj` and adds it to the solution.
- Remove from Solution command: removes a project reference from the solution file (without deleting files on disk).
- Build Project command: runs `dotnet build` for the selected project in a dedicated terminal.
- Run Project command: runs `dotnet run` for the selected project in a dedicated terminal.
- Open in Editor command: opens the raw `.sln` or `.slnx` file in the VS Code editor.
- Drag-and-drop support: move projects between Solution Folders (or to root) by dragging in the tree.
- Settings gear button in the view title for quick access to extension settings.
- `confirmMove` setting: toggles confirmation dialog before drag-and-drop moves.

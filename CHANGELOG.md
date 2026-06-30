# Changelog

All notable changes to the "csharp-solution-explorer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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

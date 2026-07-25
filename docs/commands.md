[← README](../README.md)

# Context Menu Commands

| Command                  | Available on                           |
| ------------------------ | -------------------------------------- |
| New Item ▶               | Project, Folder                        |
| — New Class…             | Project, Folder                        |
| — New Interface…         | Project, Folder                        |
| — New Record…            | Project, Folder                        |
| — New Enum…              | Project, Folder                        |
| — New Struct…            | Project, Folder                        |
| — New Razor Component…   | Project, Folder                        |
| — New File…              | Project, Folder                        |
| New Folder…              | Project, Folder                        |
| New Solution Folder…     | Solution, Solution Folder              |
| New Project…             | Solution, Solution Folder              |
| Add Existing Project…    | Solution, Solution Folder              |
| Add Project Reference…   | Project, Dependencies, Projects        |
| Remove (reference)       | Project reference                      |
| Add Package…             | Project, Dependencies, Packages        |
| Update Package…          | Package                                |
| Update to Latest Version | Outdated package                       |
| Remove Package           | Package                                |
| Manage NuGet Packages…   | Solution, Project, Dependencies        |
| Set as Startup Project   | Project                                |
| Select Launch Profile…   | Project                                |
| Build                    | Project, Solution                      |
| Rebuild                  | Project, Solution                      |
| Run Project              | Project                                |
| Test                     | Project, Solution                      |
| Restore                  | Project, Solution                      |
| Clean                    | Project, Solution                      |
| Copy / Cut               | Folder, File                           |
| Paste                    | Project, Folder                        |
| Rename…                  | Project, Solution Folder, Folder, File |
| Delete                   | Project, Solution Folder, Folder, File |
| Remove from Solution     | Project                                |
| Open in Editor           | Project, Solution node                 |
| Open in Terminal         | Solution, Project, Folder              |
| Show in Finder/Explorer  | Solution, Project, Folder, File        |
| Show in Solution Explorer| Editor tab, Command Palette            |

## Command details

- **New Item submenu**: prompts for a name and creates the file in the target folder. The namespace is derived automatically from the project name and folder path. All templates are configurable — see [Settings](settings.md).
- **New Razor Component…**: enforces the Blazor convention that component names start with an uppercase letter.
- **New File…**: accepts any filename with extension and creates an empty file.
- **Rename**: updates the solution file entry and root folder when renaming a project or Solution Folder.
- **Delete**: moves files and folders to trash; removes the project or Solution Folder entry from the solution file.
- **Remove from Solution**: removes the project reference from the solution file without deleting files on disk.
- **New Project…**: scaffolds a new project from a `dotnet new` template (Console, Class Library, Web API, Blazor, test projects, and more), creates it in a folder next to the solution, and registers it in the `.sln`/`.slnx` file.
- **Build / Rebuild / Run / Test / Restore / Clean**: runs the matching `dotnet` command in a dedicated VS Code terminal. Build, Rebuild, Test, Restore, and Clean work on both project and solution nodes; Run is project-only. **Rebuild** uses `dotnet build --no-incremental` to force a full recompile. **Test** is the plain `dotnet test` transcript in a terminal; for per-test results, single-test runs, debugging and coverage use the [Test Explorer](../README.md#test-explorer) in VS Code's Testing view instead.
- **Copy / Cut / Paste**: copies or moves files and folders on disk. Paste targets a folder or a project's root. Copy into a location that already has a file of that name appends a `… copy` suffix instead of overwriting; Cut moves the item and clears the clipboard.
- **Open in Terminal**: opens an integrated terminal whose working directory is the solution folder, the project root, or the selected folder.
- **Reveal in Finder / File Explorer**: opens the selected item in the operating system's file manager (Finder on macOS, File Explorer on Windows, the default file manager on Linux). The menu label matches your platform.
- **Show in Solution Explorer**: reveals and selects a file in the tree — from the editor tab's context menu or the Command Palette.
- **Open in Editor**: opens the raw `.sln`/`.slnx` (on a solution) or `.csproj` (on a project) file in the editor. The project's own `.csproj` is not listed as a child file — use this command to open it.

## Drag and drop

Projects can be dragged between Solution Folders (or to the solution root) directly in the tree. A confirmation dialog is shown before the move (`csharpSolutionExplorer.confirmMove`).

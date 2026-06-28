# C# Solution Explorer

A lightweight Solution Explorer for C# projects in VS Code — and in Open VSX-compatible editors such as VSCodium.

![C# Solution Explorer Tree View](resources/screenshots/tree-view.png)

![Context Menu](resources/screenshots/context-menu.png)

## Vision

The long-term goal is a VS Code extension that gives C# (and Razor) developers everything they need to write and debug their code, without depending on Microsoft-proprietary-only extensions (like C# Dev Kit) that aren't available on Open VSX. That full scope — language features, IntelliSense, debugging — is **not** part of this version.

## Features

- Dedicated Activity Bar view showing `Solution → Solution Folders → Projects → Folders/Files`.
- Parses `.sln` and `.slnx` solution files, including Solution Folder nesting.
- Falls back to a loose top-level `.csproj` when no solution file is found.
- Folders and files are read directly from disk (no MSBuild evaluation), excluding `bin`, `obj`, `node_modules`, and hidden directories.
- Manual refresh button and automatic refresh via a file system watcher.
- Click a file to open it in the editor.

### Context menu commands

| Command               | Available on                           |
| --------------------- | -------------------------------------- |
| New Class…            | Project, Folder                        |
| New Interface…        | Project, Folder                        |
| New Folder…           | Project, Folder                        |
| New Solution Folder…  | Solution, Solution Folder              |
| Add Existing Project… | Solution, Solution Folder              |
| Build Project         | Project                                |
| Run Project           | Project                                |
| Rename…               | Project, Solution Folder, Folder, File |
| Delete                | Project, Solution Folder, Folder, File |
| Remove from Solution  | Project                                |
| Open in Editor        | Solution node                          |

- **New Class / New Interface**: prompts for a name and creates a `.cs` file with a namespace derived from the project name and folder path.
- **Rename**: updates the solution file entry and root folder when renaming a project or Solution Folder.
- **Delete**: moves files and folders to trash; removes the project or Solution Folder entry from the solution file.
- **Remove from Solution**: removes the project reference from the solution file without deleting files on disk.
- **Build / Run**: runs `dotnet build` / `dotnet run` in a dedicated VS Code terminal.
- **Open in Editor**: opens the raw `.sln` or `.slnx` file in the editor.

### Drag and drop

Projects can be dragged between Solution Folders (or to the solution root) directly in the tree.

### Settings

| Setting                                | Default | Description                                              |
| -------------------------------------- | ------- | -------------------------------------------------------- |
| `csharpSolutionExplorer.confirmMove`   | `true`  | Show a confirmation dialog before a drag-and-drop move.  |

The gear icon in the view title opens the extension settings directly.

## Requirements

- **VS Code ≥ 1.85** (or a compatible Open VSX editor).
- **.NET CLI** (`dotnet`) must be on your `PATH` for the Build Project and Run Project commands.

## Development

```bash
npm install
```

Press `F5` in VS Code to launch the Extension Development Host with the sample solution (`samples/CSharpSolutionExplorer.Sample`) already open.

```bash
npm run lint
npm run check-types
npm test
```

## License

[MIT](LICENSE)

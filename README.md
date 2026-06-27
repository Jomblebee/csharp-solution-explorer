# C# Solution Explorer

A lightweight Solution Explorer for C# projects in VS Code — and in Open VSX-compatible editors such as VSCodium.

## Vision

The long-term goal is a VS Code extension that gives C# (and Razor) developers everything they need to write and debug their code, without depending on Microsoft-proprietary-only extensions (like C# Dev Kit) that aren't available on Open VSX. That full scope — language features, IntelliSense, debugging — is **not** part of this version.

## Current status (v1)

- A dedicated Activity Bar view showing `Solution → Projects → Folders/Files`.
- Discovers projects by parsing classic `.sln` files; falls back to a loose top-level `.csproj` if no `.sln` is found.
- Folders/files are read directly from disk (no MSBuild evaluation), excluding `bin`, `obj`, `node_modules`, and hidden directories.
- Manual refresh (view-title button) plus automatic refresh via a file system watcher.
- Click a file to open it in the editor.
- New Class / New Folder via context menu (class files get a namespace derived from the project name and folder structure).
- Rename files, folders, and projects (project rename also updates the `.sln` entry and the root folder).
- Delete files, folders, and projects (moves to trash; project delete also removes the `.sln` entry).
- Build and Run project via context menu (runs `dotnet build` / `dotnet run` in a dedicated terminal).

**Not yet implemented** (intentionally out of scope for v1): Dependencies/Packages/Frameworks nodes, solution-folder nesting, the newer `.slnx` solution format, any C# language features, debugging, Razor-specific tooling, and drag-and-drop reordering.

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

# C# Solution Explorer

A C# Solution Explorer for VS Code — and Open VSX-compatible editors such as VSCodium — with an **optional bundled Roslyn language server**, so you can get IntelliSense without any Microsoft-proprietary extension.

![C# Solution Explorer Tree View](resources/screenshots/tree-view.png)

![Context Menu](resources/screenshots/context-menu.png)

## Vision

The long-term goal is a VS Code extension that gives C# (and Razor) developers everything they need to write and debug their code, without depending on Microsoft-proprietary-only extensions (like C# Dev Kit) that aren't available on Open VSX. As a step toward that, this version can now host its **own C# language server** (Roslyn) for IntelliSense — see [C# Language Server](#c-language-server-experimental) below. Razor (`.razor` / `.cshtml`) gets a proper language mode and syntax highlighting; **cohosting** for full Razor IntelliSense (the Razor service inside the same Roslyn process) is **on by default**, using the bundled server's built-in Razor support. Razor **debugging** is still **not** part of this version.

## Features

- Dedicated Activity Bar view showing `Solution → Solution Folders → Projects → Folders/Files`.
- Parses `.sln` and `.slnx` solution files, including Solution Folder nesting.
- Falls back to a loose top-level `.csproj` when no solution file is found.
- Folders and files are read directly from disk (no MSBuild evaluation), excluding `bin`, `obj`, `node_modules`, and hidden directories.
- Per-project **Dependencies** tree grouped into Visual Studio-style categories (Frameworks, Analyzers, Packages, Projects), with full NuGet and project-reference management — see [Dependencies](#dependencies).
- **NuGet Package Manager** panel with Browse / Installed / Updates / Consolidate tabs over a solution-wide project checklist, package READMEs, and deprecation and vulnerability badges — see [NuGet Package Manager](#nuget-package-manager).
- **C# debugging (F5)** via a bundled netcoredbg debugger — no Microsoft-proprietary extension required — with launch profiles from `launchSettings.json`, startup project selection, and a real console via **Debug Startup Project in External Terminal** — see [Debugging](#debugging).
- **File nesting** groups related files under a parent, like Visual Studio: `appsettings.*.json` under `appsettings.json`, `.xaml.cs` under `.xaml`, `.Designer.cs`/`.cs` under `.resx`, `*.min.css`/`*.min.js` under their source, and `.razor` companions under the component. Toggle with `csharpSolutionExplorer.fileNesting.enabled`.
- Manual refresh button and automatic refresh via a file system watcher.
- Click a file to open it in the editor.
- **Auto-sync**: the active editor's file is selected (and its parents expanded) in the tree automatically. Toggle with `csharpSolutionExplorer.autoReveal`, or reveal on demand from an editor tab's context menu / the Command Palette (**Show in Solution Explorer**).
- **Copy / Cut / Paste** files and folders between folders and projects, from the context menu or with `Ctrl/Cmd+C` / `X` / `V` while the view is focused.

### Context menu commands

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

- **New Item submenu**: prompts for a name and creates the file in the target folder. The namespace is derived automatically from the project name and folder path. All templates are configurable — see [Settings](#settings) below.
- **New Razor Component…**: enforces the Blazor convention that component names start with an uppercase letter.
- **New File…**: accepts any filename with extension and creates an empty file.
- **Rename**: updates the solution file entry and root folder when renaming a project or Solution Folder.
- **Delete**: moves files and folders to trash; removes the project or Solution Folder entry from the solution file.
- **Remove from Solution**: removes the project reference from the solution file without deleting files on disk.
- **New Project…**: scaffolds a new project from a `dotnet new` template (Console, Class Library, Web API, Blazor, test projects, and more), creates it in a folder next to the solution, and registers it in the `.sln`/`.slnx` file.
- **Build / Rebuild / Run / Test / Restore / Clean**: runs the matching `dotnet` command in a dedicated VS Code terminal. Build, Rebuild, Test, Restore, and Clean work on both project and solution nodes; Run is project-only. **Rebuild** uses `dotnet build --no-incremental` to force a full recompile.
- **Copy / Cut / Paste**: copies or moves files and folders on disk. Paste targets a folder or a project's root. Copy into a location that already has a file of that name appends a `… copy` suffix instead of overwriting; Cut moves the item and clears the clipboard.
- **Open in Terminal**: opens an integrated terminal whose working directory is the solution folder, the project root, or the selected folder.
- **Reveal in Finder / File Explorer**: opens the selected item in the operating system's file manager (Finder on macOS, File Explorer on Windows, the default file manager on Linux). The menu label matches your platform.
- **Show in Solution Explorer**: reveals and selects a file in the tree — from the editor tab's context menu or the Command Palette.
- **Open in Editor**: opens the raw `.sln`/`.slnx` (on a solution) or `.csproj` (on a project) file in the editor. The project's own `.csproj` is not listed as a child file — use this command to open it.

### Dependencies

Each project has a **Dependencies** node that mirrors Visual Studio, grouping references into **Frameworks**, **Analyzers**, **Packages**, and **Projects** (empty categories are hidden). It is resolved from `project.assets.json` after a restore — so it reflects exactly what was restored, including transitive packages — and falls back to reading the `.csproj` directly when no restore has run.

- **NuGet packages**: **Add Package…** opens a Quick Pick that searches nuget.org live as you type, followed by a version pick. Direct packages offer **Update Package…** (pick any version) and **Remove Package**. All writes go through the `dotnet` CLI, so versions resolve and a restore keeps the tree in sync. For solution-wide work — installing into several projects at once, or reconciling versions between them — use the [NuGet Package Manager](#nuget-package-manager) panel instead.
- **Outdated packages**: when `csharpSolutionExplorer.nuget.checkForUpdates` is enabled (default), expanding the **Packages** node checks nuget.org for newer stable versions. Outdated direct packages are highlighted as `installed → latest` with an **Update to Latest Version** one-click action. Results are cached for the session.
- **Project references**: **Add Project Reference…** lets you select one or more other projects to reference; **Remove** drops a direct reference. Each reference can be expanded to reveal the referenced project's own references — fully recursive, dimmed, with cycle protection.

### NuGet Package Manager

For anything spanning more than one project, **Manage NuGet Packages…** opens a full panel in the editor area — the view's toolbar button, a context menu on the solution, a project or **Dependencies**, or the Command Palette. It mirrors Visual Studio's "Manage Packages for Solution": a project checklist on the right applies every action across the projects you tick.

- **Browse** searches nuget.org as you type (with an **Include prerelease** toggle) and installs the version you pick into the checked projects.
- **Installed** lists every package in the solution with the versions in use and how many projects reference each.
- **Updates** lists packages with a newer stable release and offers **Update all**, or one package at a time. An update only ever moves a project *up*.
- **Consolidate** lists packages sitting at different versions across the solution and settles them on a version you choose — this one may move a project *down* onto that version, which is the point.
- The **detail pane** shows description, authors, license, project link, dependencies per target framework and the package's README, plus badges for deprecated versions (with the author's suggested replacement) and security advisories (linking to the advisory). READMEs are rendered by a small built-in sanitizer, and their links open in your browser.

Long-running operations run in a cancellable progress notification and report per project, so one failing project never aborts the rest.

**Central Package Management**: when versions come from a `Directory.Packages.props`, the panel reads its `<PackageVersion>` entries — so packages are listed even before the first restore — and disables install/update/uninstall with a banner naming the file, since the version belongs there and not in the project. The props file is resolved from each project directory upwards, the way MSBuild does.

### Drag and drop

Projects can be dragged between Solution Folders (or to the solution root) directly in the tree.

### Settings

| Setting                                            | Default       | Description                                                                                        |
| -------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `csharpSolutionExplorer.confirmMove`               | `true`        | Show a confirmation dialog before a drag-and-drop move.                                            |
| `csharpSolutionExplorer.nuget.checkForUpdates`     | `true`        | Check nuget.org for newer versions of direct packages and flag outdated ones.                      |
| `csharpSolutionExplorer.fileNesting.enabled`       | `true`        | Group related files under a parent (e.g. `appsettings.*.json`, `.xaml.cs`).                        |
| `csharpSolutionExplorer.autoReveal`                | `true`        | Automatically select the active editor's file in the Solution Explorer tree.                       |
| `csharpSolutionExplorer.debug.enabled`             | `true`        | Provide C# debugging via the bundled netcoredbg debugger; turn off to use another C# debug extension instead. |
| `csharpSolutionExplorer.debug.handleF5`            | `true`        | Let F5 start the startup project directly, with no `launch.json` and no debugger picker.            |
| `csharpSolutionExplorer.debug.ignoreLaunchJson`    | `true`        | Keep F5 on the startup project even when the workspace has its own `launch.json`; turn off to make `launch.json` the escape hatch again. |
| `csharpSolutionExplorer.debug.offerConfigurations` | `always`      | Whether this debugger's configurations appear in the F5 picker and Run and Debug dropdown (`always` / `auto` / `never`). |
| `csharpSolutionExplorer.debug.f5Console`           | `internalConsole` | Where F5's program output appears; `externalTerminal` spawns it in a real terminal and attaches instead — see [Debugging](#debugging). |
| `csharpSolutionExplorer.debug.buildBeforeLaunch`   | `true`        | Build the project before starting a debug session, so breakpoints match the running code.          |
| `csharpSolutionExplorer.debug.externalTerminalAttachDelayMs` | `0` | Delay before attaching in the external-terminal flow, biasing (not guaranteeing) catching breakpoints hit very early in `Main()`. |
| `csharpSolutionExplorer.debug.version`             | *(bundled)*   | Pin a specific netcoredbg release tag instead of the one bundled with this extension.               |
| `csharpSolutionExplorer.debug.debuggerPath`        | *(empty)*     | Path to a locally built netcoredbg executable — required on platforms with no published build (Intel macOS, Windows on ARM, musl-based Linux). |
| `csharpSolutionExplorer.debug.logging`             | `false`       | Write a netcoredbg trace log next to the debug adapter, for diagnosing debugger problems.           |
| `csharpSolutionExplorer.languageServer.enabled`    | `true`        | Run the bundled Roslyn C# language server (auto-off when the Microsoft C# extension is installed). |
| `csharpSolutionExplorer.languageServer.version`    | *(pinned)*    | Pin a specific `roslyn-language-server` version (from the feed); empty uses the bundled default.   |
| `csharpSolutionExplorer.languageServer.serverPath` | *(empty)*     | Path to a locally installed server (skips the download) — for offline/enterprise use.              |
| `csharpSolutionExplorer.languageServer.logLevel`   | `Information` | Log verbosity passed to the language server.                                                       |
| `csharpSolutionExplorer.languageServer.razor.enabled` | `true`     | Razor (`.razor`/`.cshtml`) language features via cohosting inside the C# server (older pinned server falls back to highlighting).       |
| `csharpSolutionExplorer.templates.class`           | *(see below)* | Template for new C# class files.                                                                   |
| `csharpSolutionExplorer.templates.interface`       | *(see below)* | Template for new C# interface files.                                                               |
| `csharpSolutionExplorer.templates.record`          | *(see below)* | Template for new C# record files.                                                                  |
| `csharpSolutionExplorer.templates.enum`            | *(see below)* | Template for new C# enum files.                                                                    |
| `csharpSolutionExplorer.templates.struct`          | *(see below)* | Template for new C# struct files.                                                                  |
| `csharpSolutionExplorer.templates.razor`           | *(see below)* | Template for new Razor component files.                                                            |

All template settings support the following variables:

| Variable       | Replaced with                                       |
| -------------- | --------------------------------------------------- |
| `${namespace}` | Namespace derived from project name and folder path |
| `${name}`      | Type or component name entered by the user          |
| `${filename}`  | Full filename including extension                   |
| `${date}`      | Today's date in `YYYY-MM-DD` format                 |
| `${cursor}`    | Initial cursor position after the file is opened    |

Clearing a template setting causes an error to be shown instead of creating the file, which lets you disable individual item types. The default values can be restored with the reset icon in VS Code Settings.

The gear icon in the view title opens the extension settings directly.

## Debugging

Press `F5` to build the startup project and start debugging it directly — no `launch.json`, no
debugger picker. The extension brings its own debugger,
**[netcoredbg](https://github.com/Samsung/netcoredbg)** (Samsung, MIT), downloaded on the first
debug session (~3.4 MB) and cached; Microsoft's `vsdbg` is deliberately not used, since its licence
restricts it to Microsoft products.

VS Code has no API for "one extension owns F5", so the extension contributes its own `F5`
keybinding and only claims it while nothing else has a stake: the Microsoft C# extension is not
installed, and `offerConfigurations` is not `never`. This still applies even when the workspace has
its own `launch.json` — turn off `csharpSolutionExplorer.debug.ignoreLaunchJson` to make a
`launch.json` the escape hatch again, or `csharpSolutionExplorer.debug.handleF5` to turn the whole
takeover off.

- **Ctrl+F5** (**Cmd+F5** on macOS) runs the startup project without debugging, in a real external
  terminal.
- **Startup project & launch profile**: two status bar items — startup project on the left,
  launch profile on its right — each a single click into its own picker, or use **Set as Startup
  Project** / **Select Launch Profile…** from a project's context menu. Launch profiles come
  straight from `Properties/launchSettings.json`, the same ones Visual Studio's run dropdown shows:
  their environment variables, `applicationUrl` and arguments apply to both debugging and **Run
  Project**. "Run without a launch profile" and "Use the default profile" are offered too. Profiles
  whose `commandName` isn't `Project` (e.g. `IISExpress`) are listed but can't be selected — they
  need Windows-only tooling.
- **Debug Startup Project in External Terminal** (editor title bar, view toolbar, Command
  Palette): netcoredbg has no way to show a *debugged* program's real console — everything it
  launches funnels into the Debug Console, breaking interactive input (`Console.ReadLine()`) and
  anything that depends on a real terminal. This command builds the project, spawns it in a real OS
  terminal instead (the same mechanism as Ctrl+F5), and attaches the debugger to that process.
  `csharpSolutionExplorer.debug.f5Console` routes plain F5 through the same flow instead of only
  offering it as a separate command. Since attaching happens once the process has already started,
  a breakpoint on the very first line of `Main()` can be missed —
  `csharpSolutionExplorer.debug.externalTerminalAttachDelayMs` biases (does not guarantee) catching
  it by delaying the program's start.
- **Set as Default Debugger** writes a `launch.json` pinning this debugger first — useful when
  another C# debug extension is installed and F5 is therefore not taken over.
- **Readable thread names** in the call stack: recovered from `/proc/<tid>/comm` on Linux; macOS and
  Windows show `Thread <id>` instead, since reading them natively would mean a per-platform native
  dependency for a label.

**Known limits of netcoredbg** (it is not on par with the proprietary `vsdbg`): expression
evaluation is weak — simple locals and arithmetic work, but property access such as `text.Length`,
calling a lambda, and LINQ queries fail in the watch window; hovering a variable while stopped shows
no value; there are no logpoints or hit-count breakpoints; collections show their internal fields
rather than a friendly element view; and async call stacks show raw state-machine frames. There is
no Just My Code, Hot Reload, Source Link or dump debugging. Breakpoints (including conditional
ones), stepping, the call stack and the locals view are solid. Verified against .NET 10 on Linux x64
and macOS arm64, for console and ASP.NET Core apps.

See [Settings](#settings) for every `csharpSolutionExplorer.debug.*` option.

## C# Language Server (experimental)

The extension can provide C# language features — IntelliSense, diagnostics, hover, go-to-definition — itself, using the open-source **Roslyn** language server (`Microsoft.CodeAnalysis.LanguageServer`). This is the first step toward a C#/.NET experience that does not depend on any Microsoft-proprietary extension.

- **Downloaded, not bundled.** On first use the correct build for your platform is downloaded from the public Azure feed and cached globally (per version), so the extension ships as a single cross-platform VSIX and no Microsoft binaries live in the repository. A progress notification is shown during the one-time download (~55–60 MB).
- **Stays out of the way of the Microsoft C# extension.** If `ms-dotnettools.csharp` is installed, the bundled server automatically stays off so you never run two language servers. Disable that extension to use the bundled server.
- **Dedicated view.** A **C# Language Server** entry in the Activity Bar shows the live status (downloading / starting / running / failed), the version and platform, the loaded solution or projects, and the current activity — with actions to **Restart Server**, **Show Server Logs**, **Open Server Cache Folder**, and **Clear Server Cache** (stops the server, deletes the download cache, and re-downloads the current version). Superseded versions are pruned automatically on start.
- **Syntax highlighting** for `.cs` and for Razor (`.razor` / `.cshtml`) is contributed by the extension, so both work without the Microsoft C# extension too. Razor files also get a dedicated **ASP.NET Razor** language mode (comment toggling, bracket matching).
- **Razor language features via cohosting (on by default).** The open-source Razor language service ships **inside** the Roslyn server package and loads **into the same Roslyn process** (no second server), with Roslyn handling the C# parts and VS Code's built-in HTML service the HTML parts. It is **enabled by default** (`csharpSolutionExplorer.languageServer.razor.enabled`): the bundled `5.10` server has built-in Razor support that the server wires up itself, so `.razor` / `.cshtml` files get hover, completion, semantic highlighting and diagnostics with no extra setup. An older server set via a `version` / `serverPath` override falls back to syntax highlighting and the language mode.

Settings live under `csharpSolutionExplorer.languageServer.*` (see [Settings](#settings)): toggle the server or Razor cohosting, pin a version, point at a locally installed server (`serverPath`, for offline/enterprise use), or change the log level.

> Razor **debugging** is **not** included yet. The current Razor status (cohosting vs. highlighting only, with the reason) is shown in the **C# Language Server** view.

## Requirements

- **VS Code ≥ 1.85** (or a compatible Open VSX editor).
- **.NET CLI** (`dotnet`) must be on your `PATH` for the Build, Rebuild, Run, Test, Restore, Clean, New Project, and NuGet package commands (Add/Update/Remove Package, and the NuGet Package Manager panel).
- A **.NET runtime** is required to run the bundled C# language server (the `dotnet` SDK above provides one). The downloaded server is ReadyToRun but framework-dependent, not self-contained.
- **Internet access** is needed on first use of the language server (to download it from the Roslyn language server feed) and to nuget.org for package search, package details and README, and the outdated-package check. All are optional — set `csharpSolutionExplorer.languageServer.serverPath` to run the server fully offline.

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

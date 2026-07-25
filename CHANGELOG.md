# Changelog

All notable changes to the "csharp-solution-explorer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.14.0] – 2026-07-25

### Added

- **Test Explorer**: C# test projects now appear in VS Code's native **Testing** view. Run or debug
  a whole project, a class or a single test method — data-driven cases nest under their method — with
  per-test results, failure messages, clickable stack frames and play icons in the editor gutter.
  Two backends are picked per project: **Microsoft.Testing.Platform** projects (MSTest with
  `EnableMSTestRunner`, xUnit v3, TUnit) speak the platform's server protocol, so their tests are
  listed as soon as the project is expanded, a filtered run sends exactly the selected tests, and
  results stream in live — this is also the only path that works on the .NET 10 SDK. **Classic
  VSTest** projects run through `dotnet test --logger trx`, where methods appear after the first run
  because there is no server to query. `[TestCategory]`/`[Trait]` names become filterable tags, and
  a test's own `Console.WriteLine` output is attached to that test — including for passing ones.
- **Run with Coverage**: line coverage for both runners, highlighted per line in the editor
  (`Microsoft.Testing.Extensions.CodeCoverage` for MTP, `coverlet.collector` for VSTest). A project
  missing its coverage package is offered the right one — for MTP the version whose major matches
  the platform the test framework brought in, since a mismatched extension restores and builds and
  then throws at host startup. Files covered by several test projects are merged rather than
  overwritten.
- **Curated run output**: the Test Results panel shows a header, build diagnostics, failures and a
  final count instead of the whole `dotnet test` transcript; the full unfiltered host log stays in
  the **C# Tests** output channel. `csharpSolutionExplorer.testExplorer.outputVerbosity`
  (`summary` / `normal` / `full`) picks the level; debug runs are always `full`, because the
  debugger attaches by reading the host's own output.
- Cancelling a run now kills the whole process tree, not just the launcher — `dotnet test` and the
  MTP server both spawn a separate test host that a plain `kill` left running.

### Changed

- **`engines.vscode` raised to `^1.88.0`** (from `^1.85.0`): the Test Explorer's coverage API is
  only available there. Editors older than 1.88 can no longer install this version.
- `THIRD_PARTY_NOTICES.md` now carries the full licence text and copyright notice of every bundled
  npm dependency, as MIT, ISC and Blue Oak require of a redistributed copy. Earlier releases named
  only three of them and listed `minimatch` under the wrong licence. The notices are generated from
  the dependency tree and verified on CI, so they cannot drift again.

## [0.13.0] – 2026-07-21

### Added

- **C# debugging (F5)**: the extension now brings its own debugger, so breakpoints, stepping, the
  call stack and locals work without any Microsoft-proprietary extension. It uses
  **[netcoredbg](https://github.com/Samsung/netcoredbg)** (Samsung, MIT), which speaks the Debug
  Adapter Protocol directly; the ~3.4 MB adapter is downloaded on the **first debug session** (not
  at startup) and cached. Microsoft's `vsdbg` is deliberately not used — its licence restricts it
  to Microsoft products.
- **F5 works with no `launch.json`**: pressing F5 builds the startup project, applies its selected
  `launchSettings.json` profile (environment variables, `applicationUrl`, arguments) and starts
  debugging. Which assembly to launch comes from MSBuild, so the debugger and **Run Project** always
  agree — including projects that relocate their output via `Directory.Build.props` or
  `UseArtifactsOutput`. Multi-targeted projects ask which framework to debug.
- **F5 starts the startup project directly** — no `launch.json`, no debugger picker. **Ctrl+F5**
  (**Cmd+F5** on macOS) runs it without debugging, in an external terminal with a real console.
  Because VS Code has no API for "one extension owns F5", the extension contributes its own `F5`
  keybinding and only claims it when nothing else has a stake: the Microsoft C# extension is not
  installed and `offerConfigurations` is not `never`. F5 keeps the extension's own startup project
  even when the workspace has its own `launch.json` — turn off
  `csharpSolutionExplorer.debug.ignoreLaunchJson` to make `launch.json` the escape hatch again.
  `csharpSolutionExplorer.debug.handleF5` disables the takeover entirely, handing F5 straight back
  to VS Code. If no startup project is set yet and the workspace has more than one project, you are
  asked once and the choice is remembered.
- **Live build progress**: the "Building…" notification now tracks real progress — restore, then
  compiling, then a per-project counter for multi-project graphs — instead of sitting on an
  indeterminate spinner, by parsing `dotnet build`'s own output as it streams.
- **Debug and run buttons in the editor title bar**: the same actions sit as icons to the right
  of the tabs, so they are reachable with the mouse and keep working even once a `launch.json`
  exists. Hide any of them with a right-click on the title bar, VS Code's own way of managing editor
  actions.
- **Debug Startup Project in External Terminal**: netcoredbg has no way to show a *debugged*
  program's real console output — everything it launches gets funneled into the Debug Console,
  breaking interactive input (`Console.ReadLine()`) and anything that depends on a real terminal.
  This command builds the startup project, spawns it in a real OS terminal (the same mechanism as
  Ctrl+F5), and has netcoredbg attach to that process instead of launching it directly. Available
  from the editor title bar, the view toolbar, and the Command Palette.
  `csharpSolutionExplorer.debug.f5Console` (`internalConsole`/`externalTerminal`) routes plain F5
  through the same flow instead of only offering it as a separate command. Since attaching happens
  once the process has already started, a breakpoint on the first line of `Main()` can be missed —
  `csharpSolutionExplorer.debug.externalTerminalAttachDelayMs` biases (does not guarantee) catching
  it by delaying the program's start.
- **Readable thread names in the call stack**: netcoredbg only reports a thread's managed
  `Thread.Name`, and the runtime's own threads have none — so the call stack was a column of
  `<No name>`. The thread ids it reports are OS thread ids, so on Linux the names are recovered from
  `/proc/<tid>/comm` and shown as `.NET Finalizer (234574)`, `.NET TP Worker (234591)`,
  `Kestrel Timer (234596)`. The id is appended because a process has several identically named
  threadpool workers. Threads you named yourself keep that name. The kernel truncates names at 15
  characters, hence `.NET Tiered Com`. macOS and Windows have no equivalent to `/proc`, so every
  thread but the main one is labelled `Thread <id>` there — unique, just not descriptive. Reading
  the names natively (`GetThreadDescription`, `proc_pidinfo`) would mean a native dependency and
  per-platform builds, which is not worth it for a label.
- **Set as Default Debugger** writes a `launch.json` with this debugger first — useful when another
  C# debug extension is installed and F5 is therefore not taken over.
  `csharpSolutionExplorer.debug.offerConfigurations` controls whether these configurations appear in
  the F5 picker at all, and `csharpSolutionExplorer.debug.enabled` turns the debugger off entirely.

  **Known limits of netcoredbg** (it is not on par with the proprietary `vsdbg`): expression
  evaluation is weak — simple locals and arithmetic work, but property access such as
  `text.Length`, calling a lambda, and LINQ queries fail in the watch window; hovering a variable
  while stopped shows no value; there are no logpoints or hit-count breakpoints; collections show
  their internal fields rather than a friendly element view; and async call stacks show raw
  state-machine frames. There is no Just My Code, Hot Reload, Source Link or dump debugging.
  Breakpoints (including conditional ones), stepping, the call stack and the locals view are solid.
  Verified against .NET 10 on macOS arm64, for console and ASP.NET Core apps. Published netcoredbg
  builds exist for macOS arm64, Linux x64/arm64 and Windows x64; on other platforms (Intel macOS,
  Windows on ARM, Alpine) point `csharpSolutionExplorer.debug.debuggerPath` at a locally built one.

- **Launch profiles**: the extension now reads a project's `Properties/launchSettings.json` — the
  same profiles Visual Studio shows in its run dropdown. **Select Launch Profile…** (project
  context menu, the status bar, or the Command Palette) picks the profile a project runs with, and
  **Run Project** passes it through as `dotnet run --launch-profile`, so the profile's environment
  variables and `applicationUrl` apply. "Run without a launch profile" and "Use the default
  profile" are offered too. Profiles whose `commandName` is not `Project` (e.g. `IISExpress`) are
  listed but cannot be selected — they need Windows-only tooling. Requires .NET SDK 6 or newer for
  the `--launch-profile` option.
- **Startup project**: **Set as Startup Project** on a project marks it with a green play icon and
  a `startup` label in the tree. The choice is remembered per workspace. **Clear Startup Project**
  (Command Palette) removes it.
- **Two status bar items**, like the Visual Studio toolbar: the left one shows the startup project,
  the right one its launch profile, and each opens its own picker on a single click — no
  intermediate menu. Clicking the profile item without a startup project asks for the project
  first, then goes straight on to the profile. The profile list is exactly what the project's
  `Properties/launchSettings.json` contains. Whether the browser opens is decided by that profile's
  own `launchBrowser` field alone; there is no separate toggle to keep in sync.

### Fixed

- **Run Project on multi-targeted projects**: `dotnet run` refuses to choose when a project sets
  `<TargetFrameworks>`, so the run command now asks which framework to use and passes
  `--framework`. Single-target projects are unaffected.

## [0.12.0] – 2026-07-18

### Added

- **NuGet Package Manager**: a full editor-area panel in the spirit of Visual Studio's "Manage
  Packages for Solution", opened from the view's toolbar, from a solution/project/Dependencies
  context menu, or from the Command Palette (**Manage NuGet Packages…**). It has **Browse**,
  **Installed**, **Updates** and **Consolidate** tabs over a solution-wide project checklist, so a
  package can be installed, updated or removed across several projects in one action. The detail
  pane shows the package's metadata, dependencies per target framework, its rendered README, and
  badges for deprecated versions and security advisories. Everything runs against the public,
  unauthenticated nuget.org v3 API and the `dotnet` CLI — no proprietary dependency.
- **Consolidate tab**: lists packages that sit at different versions across the solution and
  settles them on a version you pick. Unlike an update this may move a project *down* onto the
  chosen version, which is the point of consolidating.
- **Central Package Management is recognised**: when a project's versions come from a
  `Directory.Packages.props`, the manager reads its `<PackageVersion>` entries (so the package list
  is populated even before the first restore) and refuses to write, explaining that the props file
  is the place to edit. Detection follows MSBuild and resolves the props file from each *project*
  directory upwards, so projects outside the solution folder are handled correctly.

## [0.11.1] – 2026-07-17

### Fixed

- **Duplicate Razor language features**: in `.razor` / `.cshtml` files every "N references" CodeLens
  and every hover appeared twice. The Roslyn server already registers the Razor document
  capabilities dynamically when cohosting, so also listing `aspnetcorerazor` in the client's static
  document selector registered a second set of providers. The selector is now C#-only (matching
  `dotnet/vscode-csharp`), and each feature runs once again.

## [0.11.0] – 2026-07-17

### Added

- **Bundled C# language server (Roslyn)**: the extension can now provide C# language features —
  IntelliSense, diagnostics, hover, go-to-definition — on its own, without the Microsoft C#
  extension. The server (the open-source `roslyn-language-server` package, MIT) is downloaded on
  first use from Microsoft's public Azure feed and cached per version, so the extension stays a
  single cross-platform VSIX. Enabled by default, but it automatically stays off when the Microsoft
  C# extension (`ms-dotnettools.csharp`) is installed. Configure it under
  `csharpSolutionExplorer.languageServer.*` (enable, pinned version, local server path, log level).
  Requires a .NET 10 runtime (the `dotnet` SDK already needed for Build/Run/Test provides one).
- **Dedicated "C# Language Server" view**: a new Activity Bar entry shows the server's live status
  (downloading / starting / running / failed), version, platform, the loaded solution or projects,
  and the current activity, with actions to restart the server, show its logs, open the cache
  folder, and clear the cache. Superseded server versions are also pruned automatically on start, so
  the cache doesn't grow across version bumps.
- **C# syntax highlighting**: the extension now contributes the `csharp` language and a TextMate
  grammar, so `.cs` files get syntax highlighting even without the Microsoft C# extension.
- **Razor syntax highlighting and language mode**: the extension now contributes the
  `aspnetcorerazor` language and a TextMate grammar (vendored MIT from `dotnet/vscode-csharp`), so
  `.razor` and `.cshtml` files get syntax highlighting and a dedicated **ASP.NET Razor** language
  mode (comment toggling, bracket matching) — without the Microsoft C# extension and on Open VSX.
- **Razor IntelliSense**: `.razor` / `.cshtml` files now get hover, completion, semantic
  highlighting, and diagnostics, by cohosting the Razor language service inside the same Roslyn
  process — no second server and nothing extra to download. On by default; toggle with the new
  `csharpSolutionExplorer.languageServer.razor.enabled` setting. An older pinned server falls back to
  syntax highlighting only. Razor **debugging** remains out of scope.

### Changed

- The extension is no longer positioned as a purely "lightweight" Solution Explorer: it can now host
  its own C# language server. Language features remain **optional and off when the Microsoft C#
  extension is present**.

## [0.10.0] – 2026-07-03

### Added

- **.NET SDK check on startup**: when a workspace is opened, the extension now verifies that an SDK
  matching the solution's needs is installed and warns (with a link to the official .NET download
  page) if not. The requirement is derived from a `global.json` pin when present, otherwise from the
  projects' target frameworks — so it flags a missing SDK, an unavailable pinned version, or a
  solution targeting a newer .NET than any installed SDK. Build/Run/Test require the SDK, so this
  replaces the previous raw `command not found` in the terminal with an actionable hint.

## [0.9.1] – 2026-07-03

### Fixed

- **Reveal in Finder / File Explorer** now works on file-nesting parent nodes (e.g. a `.razor`
  with companions), which previously did nothing because the nested-parent node was not
  recognized.
- **Auto-sync** no longer auto-expands a file-nesting parent when it becomes the active editor.
  Opening a parent file now just selects it (kept collapsed); opening a nested child still
  expands its parent so the child stays visible.

## [0.9.0] – 2026-07-01

### Added

- **Auto-sync with the active editor**: the file of the active editor is now automatically
  selected (and its parents expanded) in the Solution Explorer tree — including files nested
  under a parent via file nesting. Toggle it with the new `csharpSolutionExplorer.autoReveal`
  setting (default: on).
- **Show in Solution Explorer**: right-click an editor tab (or use the Command Palette) to
  reveal the current file in the tree.
- **Copy / Cut / Paste**: files and folders can now be copied, cut, and pasted between folders
  and projects — via the context menu or `Ctrl/Cmd+C` / `X` / `V` while the view is focused.
  Copy resolves name collisions with a `… copy` suffix; cut reuses the existing move logic.
- **Open in Terminal**: right-click a solution, project, or folder to open an integrated
  terminal in that directory.
- **Reveal in Finder / File Explorer**: right-click a solution, project, folder, or file to
  open it in the OS file manager. The label adapts to the platform (Finder / File Explorer /
  file manager).

## [0.8.0] – 2026-07-01

### Added

- **File nesting**: related files are now grouped under a parent node, like Visual Studio —
  `appsettings.*.json` under `appsettings.json`, `.xaml.cs` code-behind under `.xaml`,
  `.Designer.cs`/`.cs` under `.resx`, and `*.min.css`/`*.min.js` under their source. The
  existing `.razor` companion nesting now runs through the same engine. Toggle it with the
  new `csharpSolutionExplorer.fileNesting.enabled` setting (default: on).

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

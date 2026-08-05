[← README](../README.md)

# Settings

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
| `csharpSolutionExplorer.debug.f5Console`           | `internalConsole` | Where F5's program output appears; `externalTerminal` spawns it in a real terminal and attaches instead — see [Debugging](debugging.md). |
| `csharpSolutionExplorer.debug.buildBeforeLaunch`   | `true`        | Build the project before starting a debug session, so breakpoints match the running code.          |
| `csharpSolutionExplorer.debug.externalTerminalAttachDelayMs` | `0` | Delay before attaching in the external-terminal flow, biasing (not guaranteeing) catching breakpoints hit very early in `Main()`. |
| `csharpSolutionExplorer.debug.version`             | *(bundled)*   | Pin a specific netcoredbg release tag instead of the one bundled with this extension.               |
| `csharpSolutionExplorer.debug.debuggerPath`        | *(empty)*     | Path to a locally built netcoredbg executable — required on platforms with no published build (Intel macOS, Windows on ARM, musl-based Linux). |
| `csharpSolutionExplorer.debug.logging`             | `false`       | Write a netcoredbg trace log next to the debug adapter, for diagnosing debugger problems.           |
| `csharpSolutionExplorer.testExplorer.enabled`      | `true`        | Show C# test projects in the native Test Explorer, run and debug individual tests, and collect coverage. Changes need a window reload. |
| `csharpSolutionExplorer.testExplorer.dashboard`    | `onRun`       | When to open the Test Run Dashboard, a live view of a run with a progress bar, a time estimate, the failures and the slowest tests: `onRun`, `onFailure` (track everything, surface it only once a test fails) or `off`. Closing its tab never cancels the run. |
| `csharpSolutionExplorer.testExplorer.outputVerbosity` | `summary`  | How much of the test host's log the Test Results panel shows (`summary` / `normal` / `full`). Build errors and host crashes always appear, the full raw log is always in the **C# Tests** output channel, and debug runs are always `full` (the debugger attaches by reading the host's own output). |
| `csharpSolutionExplorer.languageServer.enabled`    | `true`        | Run the bundled Roslyn C# language server (auto-off when the Microsoft C# extension is installed). |
| `csharpSolutionExplorer.languageServer.version`    | *(pinned)*    | Pin a specific `roslyn-language-server` version (from the feed); empty uses the bundled default.   |
| `csharpSolutionExplorer.languageServer.serverPath` | *(empty)*     | Path to a locally installed server (skips the download) — for offline/enterprise use.              |
| `csharpSolutionExplorer.languageServer.logLevel`   | `Information` | Log verbosity passed to the language server.                                                       |
| `csharpSolutionExplorer.languageServer.razor.enabled` | `true`     | Razor (`.razor`/`.cshtml`) language features via cohosting inside the C# server (older pinned server falls back to highlighting).       |
| `csharpSolutionExplorer.build.reuseMsBuildNodes`   | `false`       | Let MSBuild worker nodes outlive the build that started them (the SDK default). Off here: an unreused pool leaves one process per core behind, each holding 150-250 MB, so an edit/build/test loop can accumulate gigabytes. See [MSBuild worker nodes](#msbuild-worker-nodes). |
| `csharpSolutionExplorer.build.maxCpuCount`         | `0`           | Cap on projects built in parallel (`-m:N`) for builds started from the Solution Explorer; `0` uses MSBuild's default of one node per CPU core. |
| `csharpSolutionExplorer.templates.class`           | *(see below)* | Template for new C# class files.                                                                   |
| `csharpSolutionExplorer.templates.interface`       | *(see below)* | Template for new C# interface files.                                                               |
| `csharpSolutionExplorer.templates.record`          | *(see below)* | Template for new C# record files.                                                                  |
| `csharpSolutionExplorer.templates.enum`            | *(see below)* | Template for new C# enum files.                                                                    |
| `csharpSolutionExplorer.templates.struct`          | *(see below)* | Template for new C# struct files.                                                                  |
| `csharpSolutionExplorer.templates.razor`           | *(see below)* | Template for new Razor component files.                                                            |

## Template variables

All template settings support the following variables:

| Variable       | Replaced with                                       |
| -------------- | --------------------------------------------------- |
| `${namespace}` | Namespace derived from project name and folder path |
| `${name}`      | Type or component name entered by the user          |
| `${filename}`  | Full filename including extension                   |
| `${date}`      | Today's date in `YYYY-MM-DD` format                 |
| `${cursor}`    | Initial cursor position after the file is opened    |

Clearing a template setting causes an error to be shown instead of creating the file, which lets you disable individual item types. The default values can be restored with the reset icon in VS Code Settings.

## MSBuild worker nodes

Every `dotnet build`, `dotnet test` and MSBuild property evaluation starts up to one MSBuild worker node per CPU core. With node reuse on — the .NET SDK default — those nodes deliberately stay alive after the command finishes, waiting for a later build to pick them up, and they are re-parented away from the process that started them. Each holds whatever its last project needed, commonly 150-250 MB.

That trade pays off in a terminal, where the next `dotnet build` usually lands on the same pool. It pays off much less in an editor, where builds, test runs and background property evaluations interleave: pools that never get reused simply sit there. On a 20-core machine a single solution build can leave around 19 processes behind, and a working session's worth reaches tens of gigabytes of resident memory.

So this extension passes `MSBUILDDISABLENODEREUSE=1` to every `dotnet` process it starts — builds, test runs, `-getProperty` evaluations, the terminals it opens for Build/Rebuild/Test/Run, and the Roslyn language server (whose design-time builds spawn nodes of their own). The cost is roughly a second of node startup per build. Set `csharpSolutionExplorer.build.reuseMsBuildNodes` to `true` to get the SDK default back, and `csharpSolutionExplorer.build.maxCpuCount` to cap how many nodes a build may start in the first place.

Nodes already left behind by earlier builds are not affected by the setting. Clear them with:

```sh
dotnet build-server shutdown
```

This also stops the Roslyn compiler server (`VBCSCompiler`) and the Razor server. Do not run it while a build is in progress — it will fail that build.

## Two ways to edit these

The view title bar has two entries:

- **Options...** (`$(settings)`) opens the **Options** panel — an editor tab in the spirit of Visual Studio's Options dialog, with the settings grouped into cards, a **User** / **Workspace** scope switcher, a search box, and a Reset button per setting. Its content is generated from this extension's manifest, so it always lists exactly the settings above.
- **Settings** (`$(gear)`) opens VS Code's built-in Settings editor, filtered to this extension.

Both write the same `settings.json`, and the Options panel updates live when a setting changes elsewhere. Use the built-in editor for what the panel deliberately does not cover: workspace-folder scope, per-language overrides, and Settings Sync. The Options panel's toolbar links straight to it, and to the underlying `settings.json`.

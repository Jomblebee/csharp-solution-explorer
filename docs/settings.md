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

The gear icon in the view title opens the extension settings directly.

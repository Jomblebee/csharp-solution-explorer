[← README](../README.md)

# Debugging

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

## Known limits of netcoredbg

netcoredbg is not on par with the proprietary `vsdbg`: expression
evaluation is weak — simple locals and arithmetic work, but property access such as `text.Length`,
calling a lambda, and LINQ queries fail in the watch window; hovering a variable while stopped shows
no value; there are no logpoints or hit-count breakpoints; collections show their internal fields
rather than a friendly element view; and async call stacks show raw state-machine frames. There is
no Just My Code, Hot Reload, Source Link or dump debugging. Breakpoints (including conditional
ones), stepping, the call stack and the locals view are solid. Verified against .NET 10 on Linux x64
and macOS arm64, for console and ASP.NET Core apps.

See [Settings](settings.md) for every `csharpSolutionExplorer.debug.*` option.

[← README](../README.md)

# Test Explorer

C# test projects appear in VS Code's native **Testing** view. They are found by scanning the
workspace for `*.csproj`, `*.fsproj` and `*.vbproj` — not by reading the `.sln`/`.slnx` — and a
project counts as a test project when it sets `<IsTestProject>true</IsTestProject>` or references a
package whose name contains `Microsoft.NET.Test.Sdk`, `xunit`, `nunit`, `mstest` or `tunit`. That
covers xUnit (v2 and v3), MSTest, NUnit and TUnit. The check reads the project file as text, with no
MSBuild evaluation, which keeps it cheap enough to redo whenever a project file changes.

Which backend runs a project is decided per project, from that same file. Projects on
**Microsoft.Testing.Platform** — recognised by `UseMicrosoftTestingPlatformRunner`,
`EnableMSTestRunner`, `EnableNUnitRunner` or `TestingPlatformDotnetTestSupport`, or by a reference
to `Microsoft.Testing.Platform`, `xunit.v3` or `tunit` — are driven over the platform's own server
protocol. Everything else runs through classic `dotnet test`. Microsoft.Testing.Platform is also the
only path that works on the .NET 10 SDK.

- **Microsoft.Testing.Platform projects** are built first, then started as `dotnet <project>.dll
  --server` and talked to over a loopback TCP socket with JSON-RPC: `initialize`, then
  `testing/discoverTests` or `testing/runTests`, then a stream of per-test notifications. Tests are
  listed as soon as a project is expanded, a filtered run sends exactly the selected tests back to
  the host, and results appear while the run is still going.
- **Classic VSTest projects** run `dotnet test --logger trx --results-directory <temp> --nologo` and
  are read back from the newest `.trx` once the process exits. There is no server to query, so test
  methods only appear after the first run; a selection becomes a
  `--filter FullyQualifiedName=…|…` expression.
- **Debugging a single test** works on both backends and always attaches the bundled netcoredbg. A
  VSTest run is started with `VSTEST_HOST_DEBUG=1` and the test host's process id is read out of its
  own output; an MTP client declares itself a debugger provider and the host asks it to attach.
  Debug runs therefore force the `full` output level, because the attach depends on reading that
  output.
- **Data-driven tests** get one item per case, nested under a group node for the method. The method
  name is the display name with its trailing `(…)` cut off, which covers both xUnit's `Adds(a: 1)`
  and the `Adds (Todo)` form MSTest writes into a TRX. Failure messages and gutter icons are
  reported per case.
- **Run with Coverage** is a separate run profile. It needs
  `Microsoft.Testing.Extensions.CodeCoverage` on an MTP project and `coverlet.collector` on a
  classic one; if either is missing, one modal dialog per run offers **Add & Continue** or **Run
  without coverage** (dismissing it cancels the run). On MTP the version is derived from the
  `Microsoft.Testing.Platform` major the framework brought in, since a mismatched extension builds
  fine and then kills the host at startup — when no version can be derived, the extension says so
  instead of guessing. Coverage is collected as Cobertura XML, merged across projects, and shown as
  per-line highlighting in the editor.
- **Output** goes to two places. The Test Results panel gets a curated log — a header, build
  errors, failures and a final count — while the full, unfiltered host log is always in the
  **C# Tests** output channel. `csharpSolutionExplorer.testExplorer.outputVerbosity`
  (`summary` / `normal` / `full`) controls only the panel.
- **Multi-targeted projects** ask which target framework to use before a run, once per project, and
  can be skipped from that picker. Only concrete `netN.N` monikers are offered.
- **Refresh** happens on its own: changing a project file re-discovers everything, changing a `.cs`,
  `.fs` or `.vb` file invalidates just that project's test list. The refresh button in the Testing
  view does the same by hand.

## Known limits

Classic VSTest projects have no discovery step — the extension cannot ask `dotnet test` what
exists without running it, so a project stays empty until its first run. Re-running a single
data-driven case runs the whole method there as well, because a VSTest filter matches the method's
fully qualified name and not the display name of one case. A TRX file carries no source positions
either, so gutter icons and clickable locations for VSTest projects come from parsing the stack
trace of a failure. Project detection is textual: a `PackageReference` needs a literal `Include=`,
so packages that arrive through Central Package Management's `Update=` form or through an MSBuild
variable are not seen. Every MTP run and every MTP discovery builds the project first, and the
handshake has fixed timeouts — 90 seconds to connect, 30 seconds to answer `initialize`.

Only statement coverage is modelled; branch and condition data in the Cobertura report is
deliberately ignored. The check for the coverage package looks at the first target framework of a
multi-targeted project only. And `csharpSolutionExplorer.testExplorer.enabled` is read once when the
extension activates, so turning the Test Explorer on or off needs a window reload.

See [Settings](settings.md) for every `csharpSolutionExplorer.testExplorer.*` option.

# Security Policy

## Supported versions

Only the latest published version gets fixes. There are no maintenance branches — a fix ships as a
new release on the VS Code Marketplace and Open VSX.

| Version | Supported |
|---------|-----------|
| latest release | yes |
| anything older | no — update first |

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: go to the
[Security tab](https://github.com/Jomblebee/csharp-solution-explorer/security) of this repository
and choose **Report a vulnerability**. That opens a private advisory visible only to you and the
maintainers.

Helpful in a report: affected version, operating system, what an attacker controls (a repository,
a solution file, a NuGet feed, a network position), and the concrete impact. A reproduction against
one of the sample solutions under `samples/` is ideal.

Expect an acknowledgement within about a week. This is a spare-time project, so a fix may take
longer than that; you will be kept posted either way. Please hold off on public disclosure until a
fixed version is out.

## What is in scope

The extension runs with the full privileges of the editor, so the interesting surface is everything
that comes from outside the machine:

- **Solution and project files** — `.sln`, `.slnx`, `.csproj`, `launchSettings.json` and
  `project.assets.json` are parsed from the opened workspace. Opening an untrusted repository must
  not lead to code execution or to writes outside that workspace.
- **Downloaded components** — the C# language server (Roslyn) and the debugger (netcoredbg) are
  fetched at runtime, unpacked and executed. Issues in download, archive extraction (path traversal
  in the zip handling) or path validation belong here.
- **nuget.org requests** — package search, package details and README, and the outdated-package
  check. Rendering of that remote content in the NuGet panel is in scope.
- **Command construction** — arguments passed to the `dotnet` CLI, to debug adapters and to
  external terminals, where a crafted project or profile name could inject additional arguments.

## What is not in scope

- Vulnerabilities in the .NET SDK, in VS Code, or in the Roslyn language server itself — report
  those to their respective projects.
- Vulnerabilities in npm dependencies with no exploitable path through this extension; those are
  handled by Dependabot in the normal release cycle.
- The sample solutions under `samples/`. They are test fixtures and are not shipped in the VSIX.

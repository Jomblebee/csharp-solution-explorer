[← README](../README.md)

# Dependencies & NuGet

## Dependencies

Each project has a **Dependencies** node that mirrors Visual Studio, grouping references into **Frameworks**, **Analyzers**, **Packages**, and **Projects** (empty categories are hidden). It is resolved from `project.assets.json` after a restore — so it reflects exactly what was restored, including transitive packages — and falls back to reading the `.csproj` directly when no restore has run.

- **NuGet packages**: **Add Package…** opens a Quick Pick that searches nuget.org live as you type, followed by a version pick. Direct packages offer **Update Package…** (pick any version) and **Remove Package**. All writes go through the `dotnet` CLI, so versions resolve and a restore keeps the tree in sync. For solution-wide work — installing into several projects at once, or reconciling versions between them — use the [NuGet Package Manager](#nuget-package-manager) panel instead.
- **Outdated packages**: when `csharpSolutionExplorer.nuget.checkForUpdates` is enabled (default), expanding the **Packages** node checks nuget.org for newer stable versions. Outdated direct packages are highlighted as `installed → latest` with an **Update to Latest Version** one-click action. Results are cached for the session.
- **Project references**: **Add Project Reference…** lets you select one or more other projects to reference; **Remove** drops a direct reference. Each reference can be expanded to reveal the referenced project's own references — fully recursive, dimmed, with cycle protection.

## NuGet Package Manager

For anything spanning more than one project, **Manage NuGet Packages…** opens a full panel in the editor area — the view's toolbar button, a context menu on the solution, a project or **Dependencies**, or the Command Palette. It mirrors Visual Studio's "Manage Packages for Solution": a project checklist on the right applies every action across the projects you tick.

- **Browse** searches nuget.org as you type (with an **Include prerelease** toggle) and installs the version you pick into the checked projects.
- **Installed** lists every package in the solution with the versions in use and how many projects reference each.
- **Updates** lists packages with a newer stable release and offers **Update all**, or one package at a time. An update only ever moves a project *up*.
- **Consolidate** lists packages sitting at different versions across the solution and settles them on a version you choose — this one may move a project *down* onto that version, which is the point.
- The **detail pane** shows description, authors, license, project link, dependencies per target framework and the package's README, plus badges for deprecated versions (with the author's suggested replacement) and security advisories (linking to the advisory). READMEs are rendered by a small built-in sanitizer, and their links open in your browser.

Long-running operations run in a cancellable progress notification and report per project, so one failing project never aborts the rest.

**Central Package Management**: when versions come from a `Directory.Packages.props`, the panel reads its `<PackageVersion>` entries — so packages are listed even before the first restore — and disables install/update/uninstall with a banner naming the file, since the version belongs there and not in the project. The props file is resolved from each project directory upwards, the way MSBuild does.

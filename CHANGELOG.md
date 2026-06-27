# Changelog

All notable changes to the "csharp-solution-explorer" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Initial Solution Explorer view in a dedicated Activity Bar container.
- `.sln` parsing to discover referenced C# projects.
- Disk-based Folders/Files tree under each project.
- Refresh command and view-title refresh button.
- Click-to-open for file nodes.
- FileSystemWatcher-based automatic tree refresh.
- Multi-root workspace support, with loose top-level `.csproj` fallback when no `.sln` is present.
- New Class command: prompts for a class name, derives a namespace from the project and folder structure, and creates a `.cs` file.
- New Folder command: creates a folder inside a project or existing folder.
- Rename command: renames files, folders, and projects (project rename also updates the `.sln` entry and root folder).
- Delete command: deletes files and folders to trash; deletes a project's root folder to trash and removes its entry from the `.sln` file.
- Build Project command: runs `dotnet build` for the selected project in a dedicated terminal.
- Run Project command: runs `dotnet run` for the selected project in a dedicated terminal.

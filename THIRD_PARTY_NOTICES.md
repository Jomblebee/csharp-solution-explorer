# Third-Party Notices

This extension includes and/or downloads third-party open-source components.

## Bundled in this repository

### C# TextMate grammar — `syntaxes/csharp.tmLanguage`

Vendored from [dotnet/csharp-tmLanguage](https://github.com/dotnet/csharp-tmLanguage),
which provides syntax highlighting for C#.

- License: MIT
- Copyright (c) .NET Foundation

```
MIT License

Copyright (c) .NET Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ASP.NET Razor TextMate grammar & language configuration — `syntaxes/aspnetcorerazor.tmLanguage.json`, `razor-language-configuration.json`

Vendored from [dotnet/vscode-csharp](https://github.com/dotnet/vscode-csharp)
(`src/razor/syntaxes/aspnetcorerazor.tmLanguage.json` and
`src/razor/language-configuration.json`), which provide syntax highlighting and
editor configuration for Razor (`.razor` / `.cshtml`) files.

- License: MIT
- Copyright (c) .NET Foundation and Contributors

(Same MIT license text as above.)

### Razor cohosting client — `src/languageServer/razor/`

The virtual-HTML-document manager and the cohosting request handlers
(`htmlDocumentManager.ts`, `razorEndpoints.ts`) are adapted from
[dotnet/vscode-csharp](https://github.com/dotnet/vscode-csharp)
(`src/lsptoolshost/razor/**` and `src/razor/src/**`), simplified for a plain
`vscode-languageclient` client.

- License: MIT
- Copyright (c) .NET Foundation and Contributors

(Same MIT license text as above.)

## Bundled runtime dependencies (via npm, MIT-licensed)

- [`vscode-languageclient`](https://github.com/microsoft/vscode-languageserver-node) — the LSP client used to talk to the Roslyn server.
- [`yauzl`](https://github.com/thejoshwolfe/yauzl) — used to unzip the downloaded server package.
- [`minimatch`](https://github.com/isaacs/minimatch) — glob matching.

## Downloaded at runtime (not distributed with this extension)

### roslyn-language-server (Roslyn C# + Razor language server)

The C# language server is downloaded on first use from Microsoft's anonymous Azure
DevOps `azure-public/vside` feed (`msft_consumption`, with a `vs-impl` fallback) — the
official `roslyn-language-server.{rid}` .NET tool packages, published by Microsoft from
the Roslyn source — and cached locally. It is **not** bundled with this extension. (The
`msft_consumption` feed carries the pinned `5.10` built-in-Razor builds; nuget.org caps
this package at `5.9`, which is why the Azure feed is used.) The same package also
contains the Razor cohost service (`Microsoft.VisualStudioCode.RazorExtension.dll` and
the Razor compiler/targets), which is loaded into the same Roslyn process (cohosting) to
provide Razor language features — there is no separate download.

- Source: <https://github.com/dotnet/roslyn> (bundles Razor bits from <https://github.com/dotnet/razor>)
- Packages: `roslyn-language-server.{rid}` from the Azure DevOps `azure-public/vside` feeds (`msft_consumption`, fallback `vs-impl`)
- License: MIT
- Copyright (c) .NET Foundation and Contributors

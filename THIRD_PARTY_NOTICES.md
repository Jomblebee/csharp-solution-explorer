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

## Bundled runtime dependencies (via npm, MIT-licensed)

- [`vscode-languageclient`](https://github.com/microsoft/vscode-languageserver-node) — the LSP client used to talk to the Roslyn server.
- [`yauzl`](https://github.com/thejoshwolfe/yauzl) — used to unzip the downloaded server package.
- [`minimatch`](https://github.com/isaacs/minimatch) — glob matching.

## Downloaded at runtime (not distributed with this extension)

### Microsoft.CodeAnalysis.LanguageServer (Roslyn)

The C# language server is downloaded on first use from the public Azure DevOps
`vs-impl` feed and cached locally. It is **not** bundled with this extension.

- Source: <https://github.com/dotnet/roslyn>
- License: MIT
- Copyright (c) .NET Foundation and Contributors

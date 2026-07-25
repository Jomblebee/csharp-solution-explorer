# Contributing

Thanks for taking the time. This is a small project, so the process is short.

## Setup

```bash
npm ci
```

Press `F5` in VS Code to launch the Extension Development Host. The `Run Extension` configuration
opens `samples/TaskFlow` — a `.slnx` solution with four projects and four test projects, one per
supported runner. To open a different folder instead, set `SOLUTION_EXPLORER_TEST_FOLDER` and use
the `Run Extension (custom folder)` configuration.

`samples/CSharpSolutionExplorer.Sample` is the second fixture: it carries both a classic `.sln` and
a `.slnx` of the same projects, which is what solution-format handling is tested against by hand.

## Verifying a change

All three must pass before a pull request:

```bash
npm run check-types
npm run lint
npm test
```

`npm run lint` runs with `--max-warnings 0`, so a warning fails the build just like an error. Do
not silence a rule repo-wide to get past it; either fix the code or add a targeted
`// eslint-disable-next-line` with a one-line reason.

Anything user-visible also needs a pass in the Extension Development Host — the tree view, context
menus and commands are not covered by the unit tests.

Optional:

```bash
npm run test:coverage   # node --experimental-test-coverage, reports on loaded src/ files only
npm run vsix            # packages into artifacts/
```

## Tests

`test/` mirrors `src/` one to one — a test for `src/solutionExplorer/parsers/slnParser.ts` lives at
`test/solutionExplorer/parsers/slnParser.test.ts`. Keep that structure when adding files.

The test runner is `node --test` via `tsx`, no framework. Two things to know:

- **No test imports `vscode`.** The module only exists inside the extension host, so anything worth
  testing is pulled out into a plain function first and the vscode call stays a thin shell around
  it. Keep it that way.
- The glob in the `test` script must stay quoted (`"test/**/*.test.ts"`). npm runs scripts through
  `sh`, where `**` without `globstar` behaves like `*` — unquoted, nested test folders are silently
  skipped and the run still exits 0.

## Samples

The sample solutions are build fixtures, and their build output is git-ignored:

```bash
npm run sample:clean            # remove every bin/ and obj/ under samples/
npm run sample:reset-coverage   # strip coverage packages so the "Add & Continue" prompt reappears
```

`npm run sample:reset-coverage -- --with-coverage` does the opposite: it pre-installs the coverage
packages so a run collects coverage without prompting.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/), with the feature area as the scope:

```
feat(testExplorer): collect code coverage
fix(solutionExplorer): keep folder nesting after a move
refactor(shared): extract debounce and add process-tree helpers
docs(readme): update screenshots
chore(lint): fail the lint script on any eslint warning
```

One logical change per pull request. Update `CHANGELOG.md` when the change is visible to users.

## Reporting problems

Bugs and feature requests go through the [issue templates](.github/ISSUE_TEMPLATE). Security
vulnerabilities do **not** — see [SECURITY.md](SECURITY.md).

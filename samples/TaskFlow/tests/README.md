# Test Explorer fixtures

Four test projects that between them cover every Test Explorer code path. Each contains passing,
intentionally failing, skipped and data-driven tests so all result states render in the tree.

| Project | Framework | Backend | Coverage package |
| --- | --- | --- | --- |
| `TaskFlow.Tests` | xUnit v2 + `Microsoft.NET.Test.Sdk` | classic VSTest (`dotnet test --logger trx`) | none → **prompts** for `coverlet.collector` |
| `TaskFlow.Tests.XUnitV3` | `xunit.v3.mtp-v2` + `UseMicrosoftTestingPlatformRunner` | MTP server protocol | none → **prompts** for `Microsoft.Testing.Extensions.CodeCoverage` (MTP v2 → 18.x) |
| `TaskFlow.Tests.MSTest` | MSTest + `EnableMSTestRunner` | MTP server protocol | transitive, MTP v1 → **no prompt** |
| `TaskFlow.Tests.TUnit` | TUnit | MTP server protocol | transitive, MTP v2 → **no prompt** |

MTP projects need `<OutputType>Exe</OutputType>` — the platform launches the test app itself.

## Testing the coverage prompt

`npm run sample:reset-coverage` puts the sample back into the state where **Run with Coverage**
raises the modal prompt, so the add-package flow can be re-tested after every experiment:

```bash
npm run sample:reset-coverage                     # strip coverage packages → prompt appears
npm run sample:reset-coverage -- --with-coverage  # pre-install them → no prompt, coverage collected
```

Round trip: **Run with Coverage** on `TaskFlow.Tests.XUnitV3` → prompt → *Add & Continue* → the run
continues and coverage decorations appear → `npm run sample:reset-coverage` → prompt again.

`TaskFlow.Tests.MSTest` and `TaskFlow.Tests.TUnit` get
`Microsoft.Testing.Extensions.CodeCoverage` transitively from their test framework, so they collect
coverage without a direct reference and must **not** be prompted — they are the fixtures for that
half of the check, which reads `obj/project.assets.json` rather than the csproj.

## Coverage package versions

The MTP extension major must match the framework's `Microsoft.Testing.Platform` major: **18.x** for
MTP v2 (`xunit.v3.mtp-v2`, current TUnit), **17.x** for MTP v1 (MSTest, `xunit.v3`). Mixing them
restores and builds cleanly but fails at startup — `TypeLoadException` or `MissingMethodException`
out of `AddSelfRegisteredExtensions`, which takes down the whole run, not just coverage. That is why
the extension pins the version it installs instead of taking the newest one.

Because the check reads the restore output, editing a csproj by hand (or running the reset script)
leaves it stale for a moment; the extension restores first when the assets file is older than the
project file.

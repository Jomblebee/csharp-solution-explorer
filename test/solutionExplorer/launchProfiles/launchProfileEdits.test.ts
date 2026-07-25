import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAddEdit,
  buildDeleteEdit,
  buildDuplicateEdit,
  buildFieldChange,
  nameExists,
  snapshot,
  toEditable,
} from "../../../src/solutionExplorer/launchProfiles/launchProfileEdits.js";
import {
  LaunchProfile,
  ParsedLaunchSettings,
} from "../../../src/solutionExplorer/parsers/launchSettingsReader.js";

/** A minimal, valid parsed profile with the given overrides. */
function profile(name: string, overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    name,
    commandName: "Project",
    launchBrowser: false,
    dotnetRunMessages: false,
    environmentVariables: {},
    ...overrides,
  };
}

function settings(...profiles: LaunchProfile[]): ParsedLaunchSettings {
  return { profiles };
}

describe("toEditable", () => {
  it("carries every editable field over", () => {
    const source = profile("http", {
      commandName: "Executable",
      executablePath: "/usr/bin/dotnet",
      commandLineArgs: "--urls http://localhost:5000",
      workingDirectory: "$(ProjectDir)",
      applicationUrl: "http://localhost:5000",
      launchUrl: "swagger",
      launchBrowser: true,
      dotnetRunMessages: true,
      environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" },
    });

    assert.deepEqual(toEditable(source), {
      commandName: "Executable",
      executablePath: "/usr/bin/dotnet",
      commandLineArgs: "--urls http://localhost:5000",
      workingDirectory: "$(ProjectDir)",
      applicationUrl: "http://localhost:5000",
      launchUrl: "swagger",
      launchBrowser: true,
      dotnetRunMessages: true,
      environmentVariables: { ASPNETCORE_ENVIRONMENT: "Development" },
    });
  });

  it("copies the environment rather than aliasing the profile's own object", () => {
    // Every builder hands the result to a `mutate` callback, so a shared reference would edit the
    // profile the snapshot was taken from.
    const source = profile("http", { environmentVariables: { A: "1" } });
    const editable = toEditable(source);
    editable.environmentVariables.B = "2";

    assert.deepEqual(source.environmentVariables, { A: "1" });
  });

  it("leaves optional fields undefined when the profile does not set them", () => {
    const editable = toEditable(profile("http"));

    assert.equal(editable.executablePath, undefined);
    assert.equal(editable.commandLineArgs, undefined);
    assert.equal(editable.launchUrl, undefined);
  });
});

describe("snapshot", () => {
  it("keeps the authored order and includes every profile", () => {
    const parsed = settings(profile("http"), profile("https"), profile("IIS Express", { commandName: "IISExpress" }));

    const { order, profiles } = snapshot(parsed);

    assert.deepEqual(order, ["http", "https", "IIS Express"]);
    assert.deepEqual(Object.keys(profiles), ["http", "https", "IIS Express"]);
    assert.equal(profiles["IIS Express"].commandName, "IISExpress");
  });

  it("returns an empty snapshot for settings without profiles", () => {
    assert.deepEqual(snapshot(settings()), { order: [], profiles: {} });
  });
});

describe("nameExists", () => {
  const parsed = settings(profile("http"), profile("https"));

  it("matches case-insensitively, like findProfile", () => {
    assert.equal(nameExists(parsed, "http"), true);
    assert.equal(nameExists(parsed, "HTTP"), true);
    assert.equal(nameExists(parsed, "grpc"), false);
  });

  it("lets a profile keep its own name on rename", () => {
    assert.equal(nameExists(parsed, "http", "http"), false);
    assert.equal(nameExists(parsed, "HTTP", "http"), false);
  });

  it("still reports a clash with a different profile while renaming", () => {
    assert.equal(nameExists(parsed, "https", "http"), true);
  });
});

describe("buildAddEdit", () => {
  it("appends the new profile with the defaults a fresh one carries", () => {
    const parsed = settings(profile("http"));

    const edit = buildAddEdit(parsed, "grpc", "Project");

    assert.deepEqual(edit.order, ["http", "grpc"]);
    assert.deepEqual(edit.profiles.grpc, {
      commandName: "Project",
      launchBrowser: false,
      dotnetRunMessages: false,
      environmentVariables: {},
    });
    assert.equal(edit.renames, undefined);
  });

  it("carries the existing profiles through unchanged, so the writer round-trips them", () => {
    const parsed = settings(profile("http", { applicationUrl: "http://localhost:5000" }));

    const edit = buildAddEdit(parsed, "grpc", "Executable");

    assert.equal(edit.profiles.http.applicationUrl, "http://localhost:5000");
    assert.equal(edit.profiles.grpc.commandName, "Executable");
  });
});

describe("buildDuplicateEdit", () => {
  it("appends a copy of the source's fields under the new name", () => {
    const source = profile("http", { applicationUrl: "http://localhost:5000", launchBrowser: true });
    const parsed = settings(source, profile("https"));

    const edit = buildDuplicateEdit(parsed, source, "http copy");

    assert.deepEqual(edit.order, ["http", "https", "http copy"]);
    assert.equal(edit.profiles["http copy"].applicationUrl, "http://localhost:5000");
    assert.equal(edit.profiles["http copy"].launchBrowser, true);
  });

  it("points the copy at the source via renames, so it inherits the source's unknown keys", () => {
    const source = profile("http");
    const edit = buildDuplicateEdit(settings(source), source, "http copy");

    assert.deepEqual(edit.renames, { "http copy": "http" });
  });
});

describe("buildDeleteEdit", () => {
  it("drops the profile from both the order and the field map", () => {
    const parsed = settings(profile("http"), profile("https"), profile("grpc"));

    const edit = buildDeleteEdit(parsed, "https");

    assert.deepEqual(edit.order, ["http", "grpc"]);
    assert.deepEqual(Object.keys(edit.profiles), ["http", "grpc"]);
    assert.equal(edit.renames, undefined);
  });

  it("is a no-op for a name that is not there", () => {
    const parsed = settings(profile("http"));

    const edit = buildDeleteEdit(parsed, "nope");

    assert.deepEqual(edit.order, ["http"]);
    assert.deepEqual(Object.keys(edit.profiles), ["http"]);
  });
});

describe("buildFieldChange", () => {
  it("applies the mutation to the target profile only", () => {
    const parsed = settings(profile("http"), profile("https"));

    const edit = buildFieldChange(parsed, "https", (f) => {
      f.launchUrl = "swagger";
    });

    assert.equal(edit.profiles.https.launchUrl, "swagger");
    assert.equal(edit.profiles.http.launchUrl, undefined);
    assert.deepEqual(edit.order, ["http", "https"]);
    assert.equal(edit.renames, undefined);
  });

  it("renames in place, keeping the profile's position", () => {
    const parsed = settings(profile("http"), profile("https"), profile("grpc"));

    const edit = buildFieldChange(parsed, "https", () => {}, "secure");

    assert.deepEqual(edit.order, ["http", "secure", "grpc"]);
    assert.deepEqual(edit.renames, { secure: "https" });
    assert.equal(edit.profiles.https, undefined);
  });

  it("mutates and renames in the same edit", () => {
    const parsed = settings(profile("http"));

    const edit = buildFieldChange(
      parsed,
      "http",
      (f) => {
        f.environmentVariables.ASPNETCORE_ENVIRONMENT = "Staging";
      },
      "web",
    );

    assert.deepEqual(edit.profiles.web.environmentVariables, { ASPNETCORE_ENVIRONMENT: "Staging" });
    assert.deepEqual(edit.renames, { web: "http" });
  });

  it("does not touch the parsed settings it was built from", () => {
    const source = profile("http", { environmentVariables: { A: "1" } });
    const parsed = settings(source);

    buildFieldChange(parsed, "http", (f) => {
      f.environmentVariables.B = "2";
      f.launchUrl = "swagger";
    });

    assert.deepEqual(source.environmentVariables, { A: "1" });
    assert.equal(source.launchUrl, undefined);
  });

  it("ignores a target name that no profile carries", () => {
    const parsed = settings(profile("http"));

    const edit = buildFieldChange(parsed, "nope", (f) => {
      f.launchUrl = "swagger";
    });

    assert.equal(edit.profiles.http.launchUrl, undefined);
    assert.deepEqual(edit.order, ["http"]);
  });
});

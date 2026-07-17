import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideHandshake } from "../src/languageServer/roslynHandshake.js";

describe("decideHandshake", () => {
  it("opens the first solution when any exists", () => {
    assert.deepEqual(decideHandshake(["/w/App.sln", "/w/nested/Other.sln"], []), {
      kind: "solution",
      solution: "/w/App.sln",
    });
  });

  it("prefers a solution over loose projects", () => {
    assert.deepEqual(decideHandshake(["/w/App.sln"], ["/w/A/A.csproj"]), {
      kind: "solution",
      solution: "/w/App.sln",
    });
  });

  it("opens loose projects when there is no solution", () => {
    assert.deepEqual(decideHandshake([], ["/w/A/A.csproj", "/w/B/B.csproj"]), {
      kind: "projects",
      projects: ["/w/A/A.csproj", "/w/B/B.csproj"],
    });
  });

  it("returns none when nothing is found", () => {
    assert.deepEqual(decideHandshake([], []), { kind: "none" });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideHandshake, HandshakeInput } from "../src/languageServer/roslynHandshake.js";

/** Builds a handshake input with sensible empty defaults, overridden per test. */
function input(over: Partial<HandshakeInput>): HandshakeInput {
  return { mode: "auto", solutions: [], projects: [], openProjects: [], ...over };
}

describe("decideHandshake", () => {
  describe("auto", () => {
    it("opens the first solution when any exists", () => {
      assert.deepEqual(
        decideHandshake(input({ solutions: ["/w/App.sln", "/w/nested/Other.sln"] })),
        { kind: "solution", solution: "/w/App.sln" },
      );
    });

    it("prefers a solution over loose projects", () => {
      assert.deepEqual(
        decideHandshake(input({ solutions: ["/w/App.sln"], projects: ["/w/A/A.csproj"] })),
        { kind: "solution", solution: "/w/App.sln" },
      );
    });

    it("opens loose projects when there is no solution", () => {
      assert.deepEqual(
        decideHandshake(input({ projects: ["/w/A/A.csproj", "/w/B/B.csproj"] })),
        { kind: "projects", projects: ["/w/A/A.csproj", "/w/B/B.csproj"] },
      );
    });

    it("returns none when nothing is found", () => {
      assert.deepEqual(decideHandshake(input({})), { kind: "none" });
    });

    it("prefers an explicit solutionPath over discovery", () => {
      assert.deepEqual(
        decideHandshake(input({ solutions: ["/w/App.sln"], solutionPath: "/w/other/Pick.sln" })),
        { kind: "solution", solution: "/w/other/Pick.sln" },
      );
    });
  });

  describe("solution", () => {
    it("opens the discovered solution", () => {
      assert.deepEqual(
        decideHandshake(input({ mode: "solution", solutions: ["/w/App.sln"] })),
        { kind: "solution", solution: "/w/App.sln" },
      );
    });

    it("never falls back to loose projects", () => {
      assert.deepEqual(
        decideHandshake(input({ mode: "solution", projects: ["/w/A/A.csproj"] })),
        { kind: "none" },
      );
    });

    it("honours an explicit solutionPath", () => {
      assert.deepEqual(
        decideHandshake(input({ mode: "solution", solutionPath: "/w/Pick.slnx" })),
        { kind: "solution", solution: "/w/Pick.slnx" },
      );
    });
  });

  describe("projects", () => {
    it("opens all projects and ignores solutions", () => {
      assert.deepEqual(
        decideHandshake(input({ mode: "projects", solutions: ["/w/App.sln"], projects: ["/w/A/A.csproj"] })),
        { kind: "projects", projects: ["/w/A/A.csproj"] },
      );
    });

    it("returns none with no projects", () => {
      assert.deepEqual(decideHandshake(input({ mode: "projects", solutions: ["/w/App.sln"] })), {
        kind: "none",
      });
    });
  });

  describe("openProjects", () => {
    it("opens only the projects owning open editors", () => {
      assert.deepEqual(
        decideHandshake(
          input({ mode: "openProjects", projects: ["/w/A/A.csproj"], openProjects: ["/w/B/B.csproj"] }),
        ),
        { kind: "projects", projects: ["/w/B/B.csproj"] },
      );
    });

    it("returns none when no open editor maps to a project", () => {
      assert.deepEqual(
        decideHandshake(input({ mode: "openProjects", projects: ["/w/A/A.csproj"] })),
        { kind: "none" },
      );
    });
  });
});

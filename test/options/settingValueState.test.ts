import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoresInherited, toValueState } from "../../src/options/settingValueState.js";

describe("toValueState", () => {
  it("falls back to the default when the scope has no entry", () => {
    const state = toValueState({ defaultValue: true }, "user");
    assert.equal(state.effective, true);
    assert.equal(state.scopeValue, undefined);
    assert.equal(state.modified, false);
    assert.equal(state.default, true);
  });

  it("reads globalValue in user scope and workspaceValue in workspace scope", () => {
    const inspect = { defaultValue: "a", globalValue: "b", workspaceValue: "c" };
    assert.equal(toValueState(inspect, "user").effective, "b");
    assert.equal(toValueState(inspect, "workspace").effective, "c");
  });

  it("treats presence as modified, even when the value equals the default", () => {
    // VS Code marks a key present in settings.json as modified regardless of its value, and Reset
    // has to stay available to remove it.
    const state = toValueState({ defaultValue: true, globalValue: true }, "user");
    assert.equal(state.modified, true);
    assert.equal(state.scopeValue, true);
  });

  it("reports a workspace override only in user scope", () => {
    const inspect = { defaultValue: 1, workspaceValue: 2 };
    assert.equal(toValueState(inspect, "user").overriddenByWorkspace, true);
    assert.equal(toValueState(inspect, "workspace").overriddenByWorkspace, undefined);
  });

  it("reports no override when the workspace has no entry", () => {
    assert.equal(toValueState({ defaultValue: 1, globalValue: 5 }, "user").overriddenByWorkspace, false);
  });

  it("survives an unknown key, where inspect returns undefined", () => {
    const state = toValueState(undefined, "user");
    assert.equal(state.effective, undefined);
    assert.equal(state.modified, false);
  });

  it("treats a false workspace value as present", () => {
    // The falsy-vs-absent distinction: `false` is a real entry, `undefined` is not.
    const state = toValueState({ defaultValue: true, workspaceValue: false }, "workspace");
    assert.equal(state.modified, true);
    assert.equal(state.effective, false);
  });
});

describe("restoresInherited", () => {
  it("collapses a write of the default value", () => {
    assert.equal(restoresInherited({ defaultValue: true, globalValue: false }, "user", true), true);
  });

  it("keeps a write that differs from the default", () => {
    assert.equal(restoresInherited({ defaultValue: true }, "user", false), false);
  });

  it("keeps a workspace write when a user entry would take over", () => {
    // Dropping the workspace entry here would fall back to "projects", not to what was just picked.
    const inspect = { defaultValue: "auto", globalValue: "projects", workspaceValue: "solution" };
    assert.equal(restoresInherited(inspect, "workspace", "auto"), false);
  });

  it("collapses a workspace write of the default when no user entry exists", () => {
    assert.equal(restoresInherited({ defaultValue: "auto", workspaceValue: "solution" }, "workspace", "auto"), true);
  });

  it("compares arrays and objects structurally", () => {
    assert.equal(restoresInherited({ defaultValue: ["a", "b"] }, "user", ["a", "b"]), true);
    assert.equal(restoresInherited({ defaultValue: ["a", "b"] }, "user", ["b", "a"]), false);
    assert.equal(restoresInherited({ defaultValue: { a: 1, b: { c: 2 } } }, "user", { b: { c: 2 }, a: 1 }), true);
    assert.equal(restoresInherited({ defaultValue: { a: 1 } }, "user", { a: 1, b: 2 }), false);
  });

  it("never collapses a reset, which is already a removal", () => {
    assert.equal(restoresInherited({ defaultValue: undefined }, "user", undefined), false);
  });

  it("keeps a write when the setting contributes no default", () => {
    assert.equal(restoresInherited({}, "user", "something"), false);
  });
});

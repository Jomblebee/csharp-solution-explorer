import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeOwnsF5, OwnsF5Input } from "../src/debug/f5Policy.js";

/** The case where F5 should be taken over; every test flips one field away from it. */
const owning = (overrides: Partial<OwnsF5Input> = {}): OwnsF5Input => ({
  handleF5: true,
  debuggerEnabledAtActivation: true,
  offerMode: "always",
  msCsharpInstalled: false,
  hasLaunchConfigurations: false,
  overrideLaunchJson: true,
  ...overrides,
});

describe("computeOwnsF5", () => {
  it("owns F5 for a C# workspace with no launch configurations", () => {
    assert.equal(computeOwnsF5(owning()), true);
  });

  it("owns F5 under offerConfigurations 'auto' as well", () => {
    assert.equal(computeOwnsF5(owning({ offerMode: "auto" })), true);
  });

  it("stands aside when the user turned handleF5 off", () => {
    assert.equal(computeOwnsF5(owning({ handleF5: false })), false);
  });

  it("stands aside when the debugger was disabled at activation", () => {
    assert.equal(computeOwnsF5(owning({ debuggerEnabledAtActivation: false })), false);
  });

  it("stands aside under offerConfigurations 'never'", () => {
    assert.equal(computeOwnsF5(owning({ offerMode: "never" })), false);
  });

  it("still owns F5 when the workspace has launch configurations of its own by default", () => {
    assert.equal(computeOwnsF5(owning({ hasLaunchConfigurations: true })), true);
  });

  it("stands aside when the workspace has launch configurations and the override is off", () => {
    assert.equal(
      computeOwnsF5(owning({ hasLaunchConfigurations: true, overrideLaunchJson: false })),
      false,
    );
  });

  it("never takes F5 from the Microsoft C# extension, not even under 'always'", () => {
    assert.equal(computeOwnsF5(owning({ msCsharpInstalled: true, offerMode: "always" })), false);
    assert.equal(computeOwnsF5(owning({ msCsharpInstalled: true, offerMode: "auto" })), false);
  });
});

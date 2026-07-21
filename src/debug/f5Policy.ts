// The single decision behind "does F5 belong to us?". Kept free of `vscode` imports so it can be
// unit-tested — everything else in `src/debug/` talks to the API and therefore cannot be.

export interface OwnsF5Input {
  /** `csharpSolutionExplorer.debug.handleF5`. */
  handleF5: boolean;
  /**
   * `csharpSolutionExplorer.debug.enabled` as read at activation — never the live value.
   * `activateDebugger` registers the adapter factory only when it was true at startup, so trusting a
   * later change would claim F5 for a debugger that has no adapter behind it.
   */
  debuggerEnabledAtActivation: boolean;
  /** `csharpSolutionExplorer.debug.offerConfigurations`. */
  offerMode: "always" | "auto" | "never";
  msCsharpInstalled: boolean;
  /** True when any workspace folder (or the .code-workspace) defines launch configurations. */
  hasLaunchConfigurations: boolean;
  /** `csharpSolutionExplorer.debug.ignoreLaunchJson`. */
  overrideLaunchJson: boolean;
}

/**
 * Deliberately stricter than `shouldOfferConfigurations`: appearing in a picker next to another C#
 * debugger is fair game, but silently taking a global keybinding away from it is not — so the
 * Microsoft C# extension blocks the takeover even under `offerConfigurations: "always"`.
 *
 * A workspace that defines its own launch configurations only stands in the way when
 * `ignoreLaunchJson` has been turned off — that is the documented escape hatch for anyone who wants
 * F5 back. By default we keep F5 on our own startup project regardless of `launch.json`.
 */
export function computeOwnsF5(input: OwnsF5Input): boolean {
  if (!input.handleF5 || !input.debuggerEnabledAtActivation) {
    return false;
  }
  if (input.offerMode === "never" || input.msCsharpInstalled) {
    return false;
  }
  if (input.hasLaunchConfigurations && !input.overrideLaunchJson) {
    return false;
  }
  return true;
}

/**
 * Version ordering for NuGet version strings. Pure and dependency-free — the one piece of the
 * nuget client that every version picker, update check and dependency badge needs, without
 * dragging the network layer along.
 */

/** Splits a version into its numeric core and its pre-release label (`""` for a stable release). */
function splitVersion(version: string): { core: number[]; prerelease: string } {
  const [core, ...rest] = version.split("+")[0].split("-");
  return {
    core: core.split(".").map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    }),
    prerelease: rest.join("-"),
  };
}

/**
 * Compares two dot-separated pre-release labels per SemVer: numeric identifiers compare numerically,
 * anything else lexically, a numeric identifier sorts below an alphanumeric one, and a longer label
 * wins when all shared identifiers are equal (`1.0-rc.1` < `1.0-rc.1.1`).
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      const diff = parseInt(l, 10) - parseInt(r, 10);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (lNum !== rNum) {
      return lNum ? -1 : 1; // numeric identifiers always sort below alphanumeric ones
    }
    const diff = l.localeCompare(r);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Compares two NuGet version strings. Returns a negative number if `a` is older than `b`, zero if
 * equal, positive if newer. Numeric segments compare numerically, non-numeric ones count as 0, and
 * differing segment counts are length-tolerant (`9.0` == `9.0.0`). When the numeric cores match, a
 * pre-release sorts *below* the matching stable release (`9.0.0-preview.1` < `9.0.0`) — without that,
 * anyone sitting on a preview would never be offered the stable version. Build metadata (`+…`) is
 * ignored, as SemVer requires. Not a full SemVer implementation, but correct for the ordering
 * decisions made here.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease || !right.prerelease) {
    return left.prerelease ? -1 : 1; // a pre-release is older than the stable release it precedes
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

import { ScannedEntry } from "./diskScanner.js";

/**
 * A single file-nesting rule: recognizes a parent file and decides which sibling files
 * are its children, so they can be collapsed underneath it (like Visual Studio's file
 * nesting). All name comparisons are case-insensitive; `name`/`parentName`/`childName`
 * are always passed lowercased by {@link computeFileNesting}.
 */
export interface NestingRule {
  /** Is `name` a potential parent for this rule (e.g. ends with ".razor", or is "appsettings.json")? */
  isParent(name: string): boolean;
  /** Is `childName` a child of `parentName` under this rule? */
  isChild(parentName: string, childName: string): boolean;
}

export interface NestingResult {
  /** parent file name (lowercase) -> its child entries, sorted alphabetically. */
  childrenByParent: Map<string, ScannedEntry[]>;
  /** Lowercase names of every nested child (to drop from the flat sibling list). */
  nestedChildNames: Set<string>;
}

/**
 * The built-in nesting rules, mirroring Visual Studio's defaults for C# projects.
 * `.razor` companions preserve the previously hard-coded behavior.
 */
export const NESTING_RULES: readonly NestingRule[] = [
  // Foo.razor -> Foo.razor.cs / Foo.razor.css / Foo.razor.js (any suffix after "Foo.razor.").
  {
    isParent: (name) => name.endsWith(".razor"),
    isChild: (parentName, childName) => childName.startsWith(parentName + "."),
  },
  // Foo.xaml -> Foo.xaml.cs (WPF/MAUI/Avalonia code-behind).
  {
    isParent: (name) => name.endsWith(".xaml"),
    isChild: (parentName, childName) => childName === parentName + ".cs",
  },
  // appsettings.json -> appsettings.Development.json, appsettings.Production.json, ...
  // Anchored to the literal base name so ordinary "foo.json" files don't nest siblings.
  {
    isParent: (name) => name === "appsettings.json",
    isChild: (_parentName, childName) =>
      childName.startsWith("appsettings.") && childName.endsWith(".json") && childName !== "appsettings.json",
  },
  // Foo.resx -> Foo.Designer.cs, Foo.cs (generated designer + code-behind).
  {
    isParent: (name) => name.endsWith(".resx"),
    isChild: (parentName, childName) => {
      const stem = parentName.slice(0, -".resx".length);
      return childName === stem + ".designer.cs" || childName === stem + ".cs";
    },
  },
  // site.css -> site.min.css, bundle.js -> bundle.min.js.
  {
    isParent: (name) => (name.endsWith(".css") || name.endsWith(".js")) && !isMinified(name),
    isChild: (parentName, childName) => {
      const dot = parentName.lastIndexOf(".");
      const stem = parentName.slice(0, dot);
      const ext = parentName.slice(dot); // ".css" | ".js"
      return childName === `${stem}.min${ext}`;
    },
  },
];

function isMinified(name: string): boolean {
  return name.endsWith(".min.css") || name.endsWith(".min.js");
}

/**
 * Groups related files under a parent for the tree view, generalizing the former Razor-only
 * companion logic. Only files nest (folders never do); a file that is already nested as a child
 * is not itself re-evaluated as a parent (no nesting chains), matching Visual Studio.
 *
 * When multiple parents could claim the same child, the longest parent name wins (e.g. a
 * "Foo.razor.cs" attaches to "Foo.razor", not a hypothetical shorter "Foo" parent).
 */
export function computeFileNesting(
  entries: ScannedEntry[],
  rules: readonly NestingRule[] = NESTING_RULES,
): NestingResult {
  const files = entries.filter((e) => e.kind === "file");

  // Resolve each child to its single best parent (lowercase name), longest parent first so the
  // most specific parent wins (e.g. "Foo.razor.cs" -> "Foo.razor", not a shorter "Foo").
  const parents = files
    .filter((e) => rules.some((r) => r.isParent(e.name.toLowerCase())))
    .sort((a, b) => b.name.length - a.name.length);

  const parentOf = new Map<ScannedEntry, string>();
  for (const child of files) {
    const childLower = child.name.toLowerCase();
    for (const parent of parents) {
      const parentLower = parent.name.toLowerCase();
      if (parentLower === childLower) {
        continue; // a file is never its own child
      }
      if (rules.some((r) => r.isParent(parentLower) && r.isChild(parentLower, childLower))) {
        parentOf.set(child, parentLower);
        break; // first (longest) matching parent wins
      }
    }
  }

  // Lowercase names of every file that is itself a child. A file in this set must not also act as
  // a parent (no nesting chains): its own would-be children stay flat rather than disappearing.
  const childNames = new Set([...parentOf.keys()].map((e) => e.name.toLowerCase()));

  const childrenByParent = new Map<string, ScannedEntry[]>();
  for (const [child, parentLower] of parentOf) {
    if (childNames.has(parentLower)) {
      continue; // parent is itself nested elsewhere — keep this file flat
    }
    const list = childrenByParent.get(parentLower) ?? [];
    list.push(child);
    childrenByParent.set(parentLower, list);
  }

  const nestedChildNames = new Set(
    [...childrenByParent.values()].flat().map((e) => e.name.toLowerCase()),
  );

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  return { childrenByParent, nestedChildNames };
}

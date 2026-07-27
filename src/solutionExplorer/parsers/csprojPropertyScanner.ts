// Reads MSBuild properties out of a project file's text: where each `<PropertyGroup>` starts and ends,
// whether it is conditioned, and every occurrence of a given property inside it.
//
// This is the read half of editing project properties, and it exists to make one distinction the
// existing regex reader cannot: whether a value is safe to *write back*. A property under a
// `Condition`, inside a `<Target>` or `<Choose>`, spread over several lines, or wrapped in CDATA is
// readable but not editable by a text writer — so the scanner reports the shape and the caller
// refuses rather than guessing.
//
// Matching is offset-based over the masked copy from xmlTextLines, so single-line groups
// (`<PropertyGroup><Nullable>enable</Nullable></PropertyGroup>`) are found too. Missing those would be
// the worst kind of failure: the writer would conclude the property is absent and add a second one.
//
// Pure — no vscode, no fs.

import {
  buildXmlTextModel,
  lineIndexAt,
  lineText,
  leadingIndent,
  overlapsAny,
  type TextRange,
  type XmlTextModel,
} from "./xmlTextLines.js";

/** Tags that make everything inside them conditional, whatever the PropertyGroup itself says. */
const CONDITIONAL_BLOCK_TAGS = ["Target", "Choose", "When", "Otherwise"];

/**
 * An attribute list. Quoted runs are matched whole so a `>` inside an attribute value — legal XML, and
 * real in conditions like `Condition="$(X) > 5"` — does not end the tag early.
 */
const ATTRIBUTES = `((?:"[^"]*"|'[^']*'|[^>"'])*?)`;

const PROPERTY_GROUP_OPEN = new RegExp(`<PropertyGroup(?=[\\s/>])${ATTRIBUTES}(\\/?)>`, "gi");
const PROPERTY_GROUP_CLOSE = /<\/PropertyGroup\s*>/gi;
const PROJECT_CLOSE = /<\/Project\s*>/i;
const CONDITION_ATTR = /\bCondition\s*=\s*"([^"]*)"/i;

export interface PropertyGroupSpan {
  /** Offset of `<`, and of the character past the matching `>` of the close tag. */
  range: TextRange;
  /** The group's body: everything between the open tag's `>` and the close tag's `<`. */
  body: TextRange;
  openLine: number;
  closeLine: number;
  indent: string;
  /** Carries a `Condition`, or sits inside a Target/Choose/When/Otherwise. */
  conditioned: boolean;
  /** The raw condition text, shown to the user verbatim rather than interpreted. */
  condition?: string;
}

/** Which text edit an occurrence admits. Anything but `inline`/`selfClosing` is read-only. */
export type OccurrenceShape = "inline" | "selfClosing" | "multiLine" | "cdata";

export interface PropertyOccurrence {
  /** The whole element, `<Tag …>…</Tag>` or `<Tag … />`. */
  range: TextRange;
  /** The inner text, for `inline` occurrences. */
  value?: TextRange;
  line: number;
  /** Index into the scan's groups, or -1 when the property sits outside any PropertyGroup. */
  groupIndex: number;
  conditioned: boolean;
  conditions: string[];
  shape: OccurrenceShape;
  /** Raw attribute text between the tag name and `>`, preserved on a rewrite. */
  attributes: string;
  /** The inner text as authored, still escaped. */
  rawValue?: string;
  /** The tag as the author spelled it — matching is case-insensitive, rewriting is not a licence to recase. */
  tagAsWritten: string;
}

export interface CsprojScan {
  model: XmlTextModel;
  groups: PropertyGroupSpan[];
  /** Offset of `<` in `</Project>`, or -1 when the file has none. */
  projectCloseOffset: number;
  projectCloseLine: number;
  /** Unbalanced PropertyGroups or a missing `</Project>`: nothing here is safe to edit. */
  malformed: boolean;
}

export type Declaration =
  | { state: "none" }
  | {
      state: "declared";
      line: number;
      value: string;
      /** Every unconditional declaration's line when there is more than one; the last one wins. */
      duplicateLines?: number[];
    }
  | { state: "conditioned"; lines: number[]; conditions: string[] }
  | { state: "unwritable"; line: number; reason: "multiLine" | "cdata" | "unexpectedLocation" };

export function scanCsproj(text: string): CsprojScan {
  const model = buildXmlTextModel(text);
  const projectClose = PROJECT_CLOSE.exec(model.masked);
  const projectCloseOffset = projectClose?.index ?? -1;

  const blocks = findConditionalBlockRanges(model.masked);
  const { groups, balanced } = findPropertyGroups(model, blocks);

  return {
    model,
    groups,
    projectCloseOffset,
    projectCloseLine: projectCloseOffset === -1 ? -1 : lineIndexAt(model, projectCloseOffset),
    malformed: !balanced || projectCloseOffset === -1,
  };
}

/** Every occurrence of `tag`, in document order. */
export function findOccurrences(scan: CsprojScan, tag: string): PropertyOccurrence[] {
  const { model } = scan;
  const pattern = new RegExp(`<(${escapeRegExp(tag)})(?=[\\s/>])${ATTRIBUTES}(\\/?)>`, "gi");
  const occurrences: PropertyOccurrence[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(model.masked)) !== null) {
    const start = match.index;
    const openEnd = start + match[0].length;
    const selfClosing = match[3] === "/";
    const attributes = match[2];

    let range: TextRange;
    let value: TextRange | undefined;
    let shape: OccurrenceShape;

    if (selfClosing) {
      range = { start, end: openEnd };
      shape = "selfClosing";
    } else {
      const closePattern = new RegExp(`<\\/${escapeRegExp(tag)}\\s*>`, "gi");
      closePattern.lastIndex = openEnd;
      const close = closePattern.exec(model.masked);
      if (!close) {
        // An unterminated element: not something a text writer should try to repair.
        continue;
      }
      range = { start, end: close.index + close[0].length };
      value = { start: openEnd, end: close.index };
      const raw = model.text.slice(value.start, value.end);
      shape = overlapsAny(model.cdata, value) ? "cdata" : /[\r\n]/.test(raw) ? "multiLine" : "inline";
      // Skip past the close tag so a nested same-named element cannot be paired twice.
      pattern.lastIndex = range.end;
    }

    const groupIndex = scan.groups.findIndex((group) => group.body.start <= start && range.end <= group.body.end);
    const group = groupIndex === -1 ? undefined : scan.groups[groupIndex];
    const elementCondition = CONDITION_ATTR.exec(attributes)?.[1];
    const conditions = [group?.condition, elementCondition].filter((entry): entry is string => Boolean(entry));

    occurrences.push({
      range,
      value,
      line: lineIndexAt(model, start),
      groupIndex,
      // Outside a PropertyGroup the property is not MSBuild-valid; it is reported so the writer can
      // refuse instead of adding a second declaration next to it.
      conditioned: Boolean(group?.conditioned) || elementCondition !== undefined,
      conditions,
      shape,
      attributes,
      rawValue: value ? model.text.slice(value.start, value.end) : undefined,
      tagAsWritten: match[1],
    });
  }

  return occurrences;
}

/**
 * What the project file says about `tag`, reduced to the four cases a properties editor has to
 * distinguish. Conditioned and unwritable occurrences are reported rather than ignored — the caller
 * needs to tell the user *why* a value it can see is not editable.
 */
export function readDeclaration(csprojText: string, tag: string): Declaration {
  const scan = scanCsproj(csprojText);
  return declarationFrom(findOccurrences(scan, tag));
}

/** The same reduction, for a caller that already scanned the file. */
export function declarationFrom(occurrences: PropertyOccurrence[]): Declaration {
  if (occurrences.length === 0) {
    return { state: "none" };
  }

  const unconditional = occurrences.filter((occurrence) => !occurrence.conditioned);
  if (unconditional.length === 0) {
    return {
      state: "conditioned",
      lines: occurrences.map((occurrence) => occurrence.line),
      conditions: [...new Set(occurrences.flatMap((occurrence) => occurrence.conditions))],
    };
  }

  // MSBuild evaluates top to bottom, so the last unconditional declaration is the effective one.
  const effective = unconditional[unconditional.length - 1];
  if (effective.groupIndex === -1) {
    return { state: "unwritable", line: effective.line, reason: "unexpectedLocation" };
  }
  if (effective.shape === "multiLine" || effective.shape === "cdata") {
    return { state: "unwritable", line: effective.line, reason: effective.shape };
  }

  return {
    state: "declared",
    line: effective.line,
    value: unescapeXmlText(effective.rawValue ?? "").trim(),
    duplicateLines:
      unconditional.length > 1 ? unconditional.map((occurrence) => occurrence.line) : undefined,
  };
}

/** Escapes a value for an element's text node. Attribute quotes are deliberately left alone. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function unescapeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key === "amp") {
      return "&";
    }
    if (key === "lt") {
      return "<";
    }
    if (key === "gt") {
      return ">";
    }
    if (key === "quot") {
      return '"';
    }
    if (key === "apos") {
      return "'";
    }
    const code = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function findPropertyGroups(
  model: XmlTextModel,
  conditionalBlocks: TextRange[],
): { groups: PropertyGroupSpan[]; balanced: boolean } {
  const groups: PropertyGroupSpan[] = [];
  const opens = [...model.masked.matchAll(PROPERTY_GROUP_OPEN)];
  const closes = [...model.masked.matchAll(PROPERTY_GROUP_CLOSE)];

  let closeCursor = 0;
  let balanced = true;

  for (const open of opens) {
    const start = open.index ?? 0;
    const openEnd = start + open[0].length;
    if (open[2] === "/") {
      continue; // `<PropertyGroup />` holds nothing to find.
    }

    while (closeCursor < closes.length && (closes[closeCursor].index ?? 0) < openEnd) {
      closeCursor++;
    }
    const close = closes[closeCursor];
    if (!close) {
      balanced = false;
      break;
    }
    closeCursor++;

    const closeStart = close.index ?? 0;
    const openLine = lineIndexAt(model, start);
    const condition = CONDITION_ATTR.exec(open[1])?.[1];
    groups.push({
      range: { start, end: closeStart + close[0].length },
      body: { start: openEnd, end: closeStart },
      openLine,
      closeLine: lineIndexAt(model, closeStart),
      indent: leadingIndent(lineText(model, openLine)),
      conditioned: condition !== undefined || overlapsAny(conditionalBlocks, { start, end: closeStart }),
      condition,
    });
  }

  // A leftover `</PropertyGroup>` is as broken as a missing one.
  return { groups, balanced: balanced && closeCursor === closes.length };
}

/** The extents of Target/Choose/When/Otherwise blocks — anything inside them is conditional. */
function findConditionalBlockRanges(masked: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const tag of CONDITIONAL_BLOCK_TAGS) {
    const open = new RegExp(`<${tag}(?=[\\s/>])${ATTRIBUTES}(\\/?)>`, "gi");
    const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
    const opens = [...masked.matchAll(open)].filter((match) => match[2] !== "/");
    const closes = [...masked.matchAll(close)];
    for (let i = 0; i < opens.length; i++) {
      const start = opens[i].index ?? 0;
      // Pair by position: these tags do not nest inside themselves in practice, and an unmatched open
      // is treated as running to the end of the file, which errs toward "conditioned".
      const end = i < closes.length ? (closes[i].index ?? masked.length) + closes[i][0].length : masked.length;
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

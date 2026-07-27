// Formatting-preserving edits to a project file's MSBuild properties.
//
// The rule this module is built around: **refuse rather than guess**. A properties editor that quietly
// writes into the wrong place damages a build in a way that is hard to trace back, so every case the
// text model cannot see clearly — a `Condition`, a value spread over several lines, CDATA, a property
// outside any PropertyGroup, unbalanced markup — comes back as a `refused*` outcome with the reason,
// and the text is returned untouched.
//
// Edits replace the smallest substring that has to change: setting a value rewrites only the inner
// text, so indentation, attribute spacing, a trailing comment on the same line and the file's line
// endings all survive without the writer having to preserve them explicitly.
//
// Pure — no vscode, no fs — mirroring csprojWriter.ts, which does the same job for `<ProjectReference>`.

import {
  applyEdits,
  leadingIndent,
  lineEndWithTerminator,
  lineRange,
  lineText,
  type TextRange,
} from "./xmlTextLines.js";
import {
  declarationFrom,
  escapeXmlText,
  findOccurrences,
  scanCsproj,
  unescapeXmlText,
  type CsprojScan,
  type PropertyOccurrence,
} from "./csprojPropertyScanner.js";

export type CsprojWriteOutcome =
  | "updated"
  | "inserted"
  | "createdGroup"
  | "removed"
  | "unchanged"
  | "refusedConditioned"
  | "refusedMultiLine"
  | "refusedInvalidValue"
  | "refusedMalformed";

export interface CsprojWriteResult {
  outcome: CsprojWriteOutcome;
  /**
   * The resulting text — always populated, and byte-identical to the input for `unchanged` and every
   * `refused*` outcome. A caller that forgets to check `outcome` therefore writes the file back
   * unchanged instead of truncating it.
   */
  text: string;
  /** For `refusedConditioned`: the conditions in the way, verbatim, for the message shown to the user. */
  blockingConditions?: string[];
  /** 0-based line of the element written, removed, or refused — for "reveal in editor". */
  line?: number;
  /** Set when several unconditional declarations existed; the last one was edited. */
  duplicateLines?: number[];
}

export interface SetPropertyOptions {
  /**
   * Only add the property when it is absent; report `unchanged` instead of modifying an existing one.
   * This is the "override in this project" path, where the intent is to introduce a local value, not
   * to edit whichever one happens to be there.
   */
  insertOnly?: boolean;
}

/** Sets `tag` to `value`, adding the property — and a `<PropertyGroup>` — if needed. */
export function setProperty(
  csprojText: string,
  tag: string,
  value: string,
  options: SetPropertyOptions = {},
): CsprojWriteResult {
  if (/[\r\n]/.test(value)) {
    // A multi-line property value needs markup this writer does not produce.
    return refuse(csprojText, "refusedInvalidValue");
  }

  const scan = scanCsproj(csprojText);
  if (scan.malformed) {
    return refuse(csprojText, "refusedMalformed");
  }

  const occurrences = findOccurrences(scan, tag);
  const unconditional = occurrences.filter((occurrence) => !occurrence.conditioned && occurrence.groupIndex !== -1);

  if (unconditional.length > 0) {
    const target = unconditional[unconditional.length - 1];
    const duplicateLines = unconditional.length > 1 ? unconditional.map((entry) => entry.line) : undefined;

    if (target.shape === "multiLine" || target.shape === "cdata") {
      return { ...refuse(csprojText, "refusedMultiLine"), line: target.line };
    }
    if (options.insertOnly || sameValue(target, value)) {
      return { outcome: "unchanged", text: csprojText, line: target.line, duplicateLines };
    }
    return { ...rewrite(csprojText, target, value), line: target.line, duplicateLines };
  }

  if (occurrences.length > 0) {
    const blocked = occurrences.filter((occurrence) => occurrence.conditioned);
    if (blocked.length > 0) {
      return {
        ...refuse(csprojText, "refusedConditioned"),
        blockingConditions: [...new Set(blocked.flatMap((occurrence) => occurrence.conditions))],
        line: blocked[0].line,
      };
    }
    // Unconditional but outside any PropertyGroup: readable, not safely editable.
    return { ...refuse(csprojText, "refusedMalformed"), line: occurrences[0].line };
  }

  return insert(scan, tag, value);
}

/**
 * Removes every unconditional declaration of `tag`, then drops any PropertyGroup this call emptied.
 *
 * All of them, not just the effective one: leaving an earlier declaration behind would silently change
 * the value rather than clear it.
 */
export function removeProperty(csprojText: string, tag: string): CsprojWriteResult {
  const scan = scanCsproj(csprojText);
  if (scan.malformed) {
    return refuse(csprojText, "refusedMalformed");
  }

  const occurrences = findOccurrences(scan, tag);
  const unconditional = occurrences.filter((occurrence) => !occurrence.conditioned && occurrence.groupIndex !== -1);

  if (unconditional.length === 0) {
    if (occurrences.length === 0) {
      return { outcome: "unchanged", text: csprojText };
    }
    const blocked = occurrences.filter((occurrence) => occurrence.conditioned);
    return blocked.length > 0
      ? {
          ...refuse(csprojText, "refusedConditioned"),
          blockingConditions: [...new Set(blocked.flatMap((occurrence) => occurrence.conditions))],
          line: blocked[0].line,
        }
      : { ...refuse(csprojText, "refusedMalformed"), line: occurrences[0].line };
  }

  const { model } = scan;
  const edits = unconditional.map((occurrence) => ({ range: removalRange(scan, occurrence), replacement: "" }));

  // Only groups this removal emptied are dropped. A `<PropertyGroup />` the author left empty is not
  // this operation's business.
  const touchedGroups = new Set(unconditional.map((occurrence) => occurrence.groupIndex));
  for (const groupIndex of touchedGroups) {
    const group = scan.groups[groupIndex];
    const remaining = removeRanges(
      model.text.slice(group.body.start, group.body.end),
      edits.map((edit) => ({ start: edit.range.start - group.body.start, end: edit.range.end - group.body.start })),
    );
    if (remaining.trim() === "") {
      edits.push({ range: groupRemovalRange(scan, groupIndex), replacement: "" });
    }
  }

  return {
    outcome: "removed",
    text: applyEdits(model.text, dropContainedRanges(edits)),
    line: unconditional[0].line,
    duplicateLines: unconditional.length > 1 ? unconditional.map((entry) => entry.line) : undefined,
  };
}

/**
 * Writes the project's target frameworks, switching between `<TargetFramework>` and `<TargetFrameworks>`
 * as the count requires.
 *
 * Two tags, one intent — so it is all-or-nothing. Both are checked before anything is written, because
 * a half-applied switch would leave the project declaring both, and MSBuild would then quietly ignore
 * the singular one.
 */
export function setTargetFrameworks(csprojText: string, frameworks: string[]): CsprojWriteResult {
  const values = frameworks.map((framework) => framework.trim()).filter((framework) => framework !== "");
  if (values.length === 0) {
    return refuse(csprojText, "refusedInvalidValue");
  }

  const targetTag = values.length === 1 ? "TargetFramework" : "TargetFrameworks";
  const otherTag = values.length === 1 ? "TargetFrameworks" : "TargetFramework";

  const scan = scanCsproj(csprojText);
  if (scan.malformed) {
    return refuse(csprojText, "refusedMalformed");
  }
  for (const tag of [targetTag, otherTag]) {
    const declaration = declarationFrom(findOccurrences(scan, tag));
    if (declaration.state === "conditioned") {
      return {
        ...refuse(csprojText, "refusedConditioned"),
        blockingConditions: declaration.conditions,
        line: declaration.lines[0],
      };
    }
    if (declaration.state === "unwritable") {
      return { ...refuse(csprojText, "refusedMultiLine"), line: declaration.line };
    }
  }

  const written = setProperty(csprojText, targetTag, values.join(";"));
  if (isRefusal(written.outcome)) {
    return written;
  }
  const cleaned = removeProperty(written.text, otherTag);
  return {
    ...written,
    // The removal cannot refuse here — both tags were cleared above — but if it somehow did, keeping
    // the successful first edit is still the safer of the two states.
    text: isRefusal(cleaned.outcome) ? written.text : cleaned.text,
  };
}

export function isRefusal(outcome: CsprojWriteOutcome): boolean {
  return outcome.startsWith("refused");
}

function refuse(text: string, outcome: CsprojWriteOutcome): CsprojWriteResult {
  return { outcome, text };
}

/** True when the declared value already means what we would write, whitespace and escaping aside. */
function sameValue(occurrence: PropertyOccurrence, value: string): boolean {
  return occurrence.shape !== "selfClosing" && unescapeXmlText(occurrence.rawValue ?? "").trim() === value;
}

function rewrite(text: string, occurrence: PropertyOccurrence, value: string): CsprojWriteResult {
  const escaped = escapeXmlText(value);
  if (occurrence.shape === "selfClosing") {
    // `<Nullable />` has nowhere to put a value; give it a body, keeping its attributes. The trailing
    // space that separated them from `/>` goes with it.
    const attributes = occurrence.attributes.replace(/\s+$/, "");
    const replacement = `<${occurrence.tagAsWritten}${attributes}>${escaped}</${occurrence.tagAsWritten}>`;
    return { outcome: "updated", text: applyEdits(text, [{ range: occurrence.range, replacement }]) };
  }
  // Only the inner text moves. Everything else on the line is outside the replaced range.
  return {
    outcome: "updated",
    text: applyEdits(text, [{ range: occurrence.value as TextRange, replacement: escaped }]),
  };
}

function insert(scan: CsprojScan, tag: string, value: string): CsprojWriteResult {
  const { model } = scan;
  const element = `<${tag}>${escapeXmlText(value)}</${tag}>`;
  const group = scan.groups.find((candidate) => !candidate.conditioned);

  if (group) {
    if (group.openLine === group.closeLine) {
      // A single-line group: append inside it rather than breaking it across lines.
      return {
        outcome: "inserted",
        text: applyEdits(model.text, [{ range: { start: group.body.end, end: group.body.end }, replacement: element }]),
        line: group.openLine,
      };
    }
    const indent = childIndent(scan, group.openLine, group.closeLine);
    const at = model.lineStarts[group.closeLine];
    return {
      outcome: "inserted",
      text: applyEdits(model.text, [{ range: { start: at, end: at }, replacement: `${indent}${element}${model.newline}` }]),
      line: group.closeLine,
    };
  }

  // No unconditional group to extend: add one just before `</Project>`, the way addProjectReference
  // adds an `<ItemGroup>`.
  const closeLine = scan.projectCloseLine;
  const indent = `${leadingIndent(lineText(model, closeLine))}  `;
  const block = [
    `${indent}<PropertyGroup>`,
    `${indent}  ${element}`,
    `${indent}</PropertyGroup>`,
    "",
  ].join(model.newline);
  const at = model.lineStarts[closeLine];
  return {
    outcome: "createdGroup",
    text: applyEdits(model.text, [{ range: { start: at, end: at }, replacement: block }]),
    line: closeLine,
  };
}

/** The indentation a new child of this group should use: a sibling's, else the group's plus two spaces. */
function childIndent(scan: CsprojScan, openLine: number, closeLine: number): string {
  for (let line = closeLine - 1; line > openLine; line--) {
    const text = lineText(scan.model, line);
    if (text.trim() !== "") {
      return leadingIndent(text);
    }
  }
  return `${leadingIndent(lineText(scan.model, openLine))}  `;
}

/**
 * What to delete for one occurrence: the whole line when the element is alone on it (so no blank line
 * is left behind), otherwise just the element.
 */
function removalRange(scan: CsprojScan, occurrence: PropertyOccurrence): TextRange {
  const line = lineRange(scan.model, occurrence.line);
  const isAlone =
    occurrence.range.start >= line.start &&
    occurrence.range.end <= line.end &&
    scan.model.text.slice(line.start, occurrence.range.start).trim() === "" &&
    scan.model.text.slice(occurrence.range.end, line.end).trim() === "";
  return isAlone
    ? { start: line.start, end: lineEndWithTerminator(scan.model, occurrence.line) }
    : occurrence.range;
}

/** The same choice for a whole PropertyGroup that has become empty. */
function groupRemovalRange(scan: CsprojScan, groupIndex: number): TextRange {
  const group = scan.groups[groupIndex];
  const openLine = lineRange(scan.model, group.openLine);
  const closeLine = lineRange(scan.model, group.closeLine);
  const isAlone =
    scan.model.text.slice(openLine.start, group.range.start).trim() === "" &&
    scan.model.text.slice(group.range.end, closeLine.end).trim() === "";
  return isAlone
    ? { start: openLine.start, end: lineEndWithTerminator(scan.model, group.closeLine) }
    : group.range;
}

/** Drops ranges fully covered by another, so a group removal and its children do not overlap. */
function dropContainedRanges(
  edits: readonly { range: TextRange; replacement: string }[],
): { range: TextRange; replacement: string }[] {
  return edits.filter(
    (edit, index) =>
      !edits.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.range.start <= edit.range.start &&
          edit.range.end <= other.range.end &&
          (other.range.end - other.range.start > edit.range.end - edit.range.start || otherIndex < index),
      ),
  );
}

/** Applies deletions to a substring, for the "is this group empty now?" check. */
function removeRanges(text: string, ranges: readonly TextRange[]): string {
  const inside = ranges
    .filter((range) => range.end > 0 && range.start < text.length)
    .sort((a, b) => b.start - a.start);
  let result = text;
  for (const range of inside) {
    result = result.slice(0, Math.max(0, range.start)) + result.slice(Math.min(text.length, range.end));
  }
  return result;
}

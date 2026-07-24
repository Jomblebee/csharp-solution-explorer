// Turns a `dotnet test --logger trx` result file into a flat list of per-test outcomes. Pure and
// vscode-free so it stays unit-testable with node:test (same split as dotnetSdkCheck.ts). Regex-based
// rather than a full XML parse: the extension ships no XML DOM dependency, and TRX's shape is stable
// enough that the handful of elements we need (TestDefinitions + Results) are cheap to match. Fails
// open — any unparseable input yields an empty summary rather than throwing.

export type TrxOutcome = "Passed" | "Failed" | "NotExecuted" | "Other";

export interface TrxTestResult {
  /** Namespace-qualified class, e.g. `MyApp.Tests.CalculatorTests`. */
  className: string;
  /** Display method name, e.g. `Adds` or a data-driven `Adds(a: 1, b: 2)`. */
  method: string;
  outcome: TrxOutcome;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
  /** Source location, when known (MTP reports it; classic TRX does not). Enables gutter icons. */
  file?: string;
  line?: number;
}

export interface TrxSummary {
  results: TrxTestResult[];
}

/** Parses a TRX document. Never throws; returns `{ results: [] }` for anything it cannot read. */
export function parseTrx(xml: string): TrxSummary {
  const defs = parseDefinitions(xml);
  const results: TrxTestResult[] = [];

  // A UnitTestResult is self-closing when the test passed, and carries an <Output>/<ErrorInfo> child
  // block when it failed — match both shapes.
  const resultPattern = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gi;
  for (const match of xml.matchAll(resultPattern)) {
    const attrs = match[1];
    const inner = match[2];
    const testId = getAttr(attrs, "testId");
    const testName = getAttr(attrs, "testName") ?? "";
    const def = testId ? defs.get(testId) : undefined;
    const className = def?.className ?? classNameFromTestName(testName);
    const method = displayMethod(className, testName, def?.method);
    const { message, stackTrace } = inner ? parseErrorInfo(inner) : {};
    results.push({
      className,
      method,
      outcome: normalizeOutcome(getAttr(attrs, "outcome")),
      durationMs: parseDuration(getAttr(attrs, "duration")),
      message,
      stackTrace,
    });
  }

  return { results };
}

/** Maps each `<UnitTest id>` to the `className`/`name` on its nested `<TestMethod>`. */
function parseDefinitions(xml: string): Map<string, { className: string; method: string }> {
  const map = new Map<string, { className: string; method: string }>();
  const unitTestPattern = /<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gi;
  for (const match of xml.matchAll(unitTestPattern)) {
    const id = getAttr(match[1], "id");
    if (!id) {
      continue;
    }
    const methodTag = /<TestMethod\b([^>]*?)\/?>/i.exec(match[2]);
    const className = methodTag ? getAttr(methodTag[1], "className") : undefined;
    if (className) {
      map.set(id, { className, method: getAttr(methodTag![1], "name") ?? "" });
    }
  }
  return map;
}

function parseErrorInfo(inner: string): { message?: string; stackTrace?: string } {
  const message = /<Message>([\s\S]*?)<\/Message>/i.exec(inner);
  const stackTrace = /<StackTrace>([\s\S]*?)<\/StackTrace>/i.exec(inner);
  return {
    message: message ? unescapeXml(message[1].trim()) : undefined,
    stackTrace: stackTrace ? unescapeXml(stackTrace[1].trim()) : undefined,
  };
}

function normalizeOutcome(raw: string | undefined): TrxOutcome {
  switch (raw) {
    case "Passed":
      return "Passed";
    case "Failed":
    case "Error":
    case "Timeout":
    case "Aborted":
      return "Failed";
    case "NotExecuted":
      return "NotExecuted";
    default:
      return "Other";
  }
}

/** Parses a TRX `hh:mm:ss.fffffff` duration into whole milliseconds. */
function parseDuration(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** `MyApp.Tests.CalcTests.Adds(a: 1)` with class `MyApp.Tests.CalcTests` → `Adds(a: 1)`. */
function displayMethod(className: string, testName: string, defMethod?: string): string {
  if (testName && className && testName.startsWith(className + ".")) {
    return testName.slice(className.length + 1);
  }
  if (defMethod) {
    return defMethod;
  }
  const lastDot = testName.lastIndexOf(".");
  return lastDot >= 0 ? testName.slice(lastDot + 1) : testName;
}

function classNameFromTestName(testName: string): string {
  const lastDot = testName.lastIndexOf(".");
  return lastDot >= 0 ? testName.slice(0, lastDot) : testName;
}

function getAttr(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)?.[1];
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x?[0-9a-fA-F]+;/g, (entity) => decodeNumericEntity(entity))
    .replace(/&amp;/g, "&");
}

function decodeNumericEntity(entity: string): string {
  const hex = /^&#x([0-9a-fA-F]+);$/.exec(entity);
  if (hex) {
    return String.fromCodePoint(parseInt(hex[1], 16));
  }
  const dec = /^&#(\d+);$/.exec(entity);
  return dec ? String.fromCodePoint(parseInt(dec[1], 10)) : entity;
}

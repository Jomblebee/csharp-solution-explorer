// Razor cohosting endpoints. Roslyn (with the Razor extension loaded) drives the HTML side of a
// `.razor`/`.cshtml` file by sending the client requests: `razor/updateHtml` pushes the generated
// HTML, and the standard `textDocument/*` requests are *forwarded* (wrapped with the target uri +
// checksum) so the client answers them with VS Code's built-in HTML language service. We run the
// matching `vscode.executeXProvider` against the projected HTML document and convert results back to
// the LSP shape. Adapted (MIT) from dotnet/vscode-csharp `src/lsptoolshost/razor/razorEndpoints.ts`
// and `src/razor/src/**`, simplified to a plain `vscode-languageclient` client.

import * as vscode from "vscode";
import { InsertTextFormat, InsertTextMode, LanguageClient } from "vscode-languageclient/node";
import { HtmlDocument, HtmlDocumentManager } from "./htmlDocumentManager.js";

interface Pos {
  line: number;
  character: number;
}
interface Range {
  start: Pos;
  end: Pos;
}
/** A `textDocument/*` request the server forwarded to us, targeting a projected HTML document. */
interface Forwarded<T> {
  textDocument: { uri: string };
  checksum: string;
  request: T;
}
interface PositionRequest {
  position: Pos;
}
interface CompletionRequest {
  position: Pos;
  context?: { triggerCharacter?: string };
}
interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}
interface ColorPresentationRequest {
  color: Color;
  range: Range;
}

type Logger = (message: string) => void;

/**
 * Registers the cohosting handlers on `client`. The returned disposable removes them (call on client
 * stop); the projected-document store in `manager` outlives individual clients.
 */
export function registerRazorEndpoints(
  client: LanguageClient,
  manager: HtmlDocumentManager,
  log: Logger,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    client.onRequest("razor/updateHtml", async (params: { textDocument: { uri: string }; checksum: string; text: string }) => {
      try {
        await manager.updateDocumentText(vscode.Uri.parse(params.textDocument.uri), params.checksum, params.text);
      } catch (err) {
        log(`Razor: failed to update HTML buffer: ${errText(err)}`);
      }
      return null;
    }),
  );

  const forward = <TReq, TRes>(
    method: string,
    empty: TRes,
    run: (doc: HtmlDocument, request: TReq) => Promise<TRes>,
  ): void => {
    disposables.push(
      client.onRequest(method, async (params: Forwarded<TReq>) => {
        try {
          const doc = await manager.getDocument(vscode.Uri.parse(params.textDocument.uri), params.checksum);
          if (!doc) {
            return empty;
          }
          return await run(doc, params.request);
        } catch (err) {
          log(`Razor: '${method}' forwarding failed: ${errText(err)}`);
          return empty;
        }
      }),
    );
  };

  forward("textDocument/hover", null, async (doc, req: PositionRequest) => {
    const hovers = await exec<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, toPos(req.position));
    const hover = (hovers ?? []).filter((h) => h.range)[0];
    return hover ? rewriteHover(hover) : null;
  });

  const locationMethods: Array<[string, string]> = [
    ["textDocument/definition", "vscode.executeDefinitionProvider"],
    ["textDocument/implementation", "vscode.executeImplementationProvider"],
    ["textDocument/references", "vscode.executeReferenceProvider"],
  ];
  for (const [method, command] of locationMethods) {
    forward(method, [] as unknown[], async (doc, req: PositionRequest) => {
      const locations = await exec<vscode.Location[]>(command, doc.uri, toPos(req.position));
      return rewriteLocations(locations ?? []);
    });
  }

  forward("textDocument/documentHighlight", [] as unknown[], async (doc, req: PositionRequest) => {
    const highlights = await exec<vscode.DocumentHighlight[]>(
      "vscode.executeDocumentHighlights",
      doc.uri,
      toPos(req.position),
    );
    return (highlights ?? []).map((h) => ({ range: toRange(h.range), kind: h.kind }));
  });

  forward("textDocument/signatureHelp", null, async (doc, req: PositionRequest) => {
    const help = await exec<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", doc.uri, toPos(req.position));
    return help ? rewriteSignatureHelp(help) : null;
  });

  forward("textDocument/completion", null, async (doc, req: CompletionRequest) => {
    return provideHtmlCompletions(doc.uri, toPos(req.position), req.context?.triggerCharacter);
  });

  // HTML-only features the Razor server delegates to us for the projected HTML document. Without these
  // handlers the server logs "Unhandled method …" for each `.razor`/`.cshtml` file.
  forward("textDocument/documentColor", [] as unknown[], async (doc) => {
    const colors = await exec<vscode.ColorInformation[]>("vscode.executeDocumentColorProvider", doc.uri);
    return (colors ?? []).map((c) => ({ range: toRange(c.range), color: toColor(c.color) }));
  });

  forward("textDocument/colorPresentation", [] as unknown[], async (doc, req: ColorPresentationRequest) => {
    const color = new vscode.Color(req.color.red, req.color.green, req.color.blue, req.color.alpha);
    const presentations = await exec<vscode.ColorPresentation[]>(
      "vscode.executeColorPresentationProvider",
      color,
      { uri: doc.uri, range: toVsRange(req.range) },
    );
    return (presentations ?? []).map((p) => ({
      label: p.label,
      textEdit: p.textEdit ? toTextEdit(p.textEdit) : undefined,
      additionalTextEdits: p.additionalTextEdits?.map(toTextEdit),
    }));
  });

  forward("textDocument/foldingRange", [] as unknown[], async (doc) => {
    const ranges = await exec<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", doc.uri);
    return (ranges ?? []).map((r) => ({ startLine: r.start, endLine: r.end, kind: foldingKind(r.kind) }));
  });

  return vscode.Disposable.from(...disposables);
}

// --- helpers ---------------------------------------------------------------

const exec = <T>(command: string, ...args: unknown[]): Thenable<T | undefined> =>
  vscode.commands.executeCommand<T>(command, ...args);

const toPos = (p: Pos): vscode.Position => new vscode.Position(p.line, p.character);
const toRange = (r: vscode.Range): Range => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});
const toVsRange = (r: Range): vscode.Range =>
  new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
const toColor = (c: vscode.Color): Color => ({ red: c.red, green: c.green, blue: c.blue, alpha: c.alpha });
const toTextEdit = (e: vscode.TextEdit): { range: Range; newText: string } => ({
  range: toRange(e.range),
  newText: e.newText,
});
/** VS Code `FoldingRangeKind` → the LSP string kind (`comment` | `imports` | `region`). */
function foldingKind(kind: vscode.FoldingRangeKind | undefined): string | undefined {
  switch (kind) {
    case vscode.FoldingRangeKind.Comment:
      return "comment";
    case vscode.FoldingRangeKind.Imports:
      return "imports";
    case vscode.FoldingRangeKind.Region:
      return "region";
    default:
      return undefined;
  }
}
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function rewriteHover(hover: vscode.Hover): { contents: { kind: "markdown"; value: string }; range?: Range } {
  const md = new vscode.MarkdownString();
  for (const content of hover.contents) {
    const asCode = content as { language?: string; value?: string };
    if (asCode.language) {
      md.appendCodeblock(asCode.value ?? "", asCode.language);
    } else {
      md.appendMarkdown((content as vscode.MarkdownString).value ?? String(content));
    }
  }
  return { contents: { kind: "markdown", value: md.value }, range: hover.range ? toRange(hover.range) : undefined };
}

function rewriteLocations(locations: vscode.Location[]): Array<{ uri: string; range: Range }> {
  return locations.map((loc) => ({ uri: loc.uri.toString(), range: toRange(loc.range) }));
}

function rewriteSignatureHelp(help: vscode.SignatureHelp): unknown {
  return {
    activeParameter: help.activeParameter,
    activeSignature: help.activeSignature,
    signatures: help.signatures.map((sig) => ({
      label: sig.label,
      documentation: markup(sig.documentation),
      parameters: sig.parameters.map((p) => ({ label: p.label, documentation: markup(p.documentation) })),
    })),
  };
}

function markup(doc: string | vscode.MarkdownString | undefined): unknown {
  if (!doc) {
    return undefined;
  }
  const md = doc as vscode.MarkdownString;
  return md.value ? { kind: "markdown", value: md.value } : { kind: "plaintext", value: String(doc) };
}

/**
 * Runs VS Code's HTML completion against the projected document and converts the result to the LSP
 * `CompletionList` shape. Faithful port of vscode-csharp's `CompletionHandler.provideVscodeCompletions`.
 */
async function provideHtmlCompletions(
  uri: vscode.Uri,
  position: vscode.Position,
  triggerCharacter: string | undefined,
): Promise<unknown> {
  const result = await exec<vscode.CompletionList | vscode.CompletionItem[]>(
    "vscode.executeCompletionItemProvider",
    uri,
    position,
    triggerCharacter,
  );
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  const isIncomplete = Array.isArray(result) ? false : (result?.isIncomplete ?? false);

  return {
    isIncomplete,
    items: items.map((item) => {
      const insertText = item.insertText;
      const snippet = insertText as vscode.SnippetString;
      const label = item.label as vscode.CompletionItemLabel;
      return {
        command: item.command,
        commitCharacters: item.commitCharacters,
        detail: item.detail,
        documentation: markup(item.documentation),
        filterText: item.filterText,
        insertText: snippet?.value ?? (insertText as string | undefined),
        insertTextFormat:
          insertText instanceof vscode.SnippetString ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
        insertTextMode:
          item.keepWhitespace === undefined
            ? undefined
            : item.keepWhitespace
              ? InsertTextMode.asIs
              : InsertTextMode.adjustIndentation,
        // VS Code CompletionItemKind is off by one from LSP.
        kind: item.kind ? item.kind + 1 : item.kind,
        label: label?.label ?? (item.label as string),
        preselect: item.preselect,
        sortText: item.sortText,
        textEdit: toCompletionEdit(snippet?.value ?? (insertText as string | undefined), item.range),
      };
    }),
  };
}

function toCompletionEdit(
  newText: string | undefined,
  range: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | undefined,
): unknown {
  if (!range) {
    return undefined;
  }
  const text = newText ?? "";
  const insertReplace = range as { inserting?: vscode.Range; replacing?: vscode.Range };
  if (insertReplace.inserting && insertReplace.replacing) {
    return { newText: text, insert: toRange(insertReplace.inserting), replace: toRange(insertReplace.replacing) };
  }
  if (!insertReplace.inserting && !insertReplace.replacing) {
    return { newText: text, range: toRange(range as vscode.Range) };
  }
  return undefined;
}

// Virtual HTML documents backing Razor cohosting. When Roslyn (with the Razor extension loaded)
// processes a `.razor`/`.cshtml` file, it pushes the generated HTML for that file to the client via
// `razor/updateHtml`; we keep it here as an in-memory document under the `razor-html:` scheme so
// VS Code's built-in HTML language service can answer the HTML parts (completion, hover, …) that
// Roslyn then forwards back to us. Adapted (MIT) from dotnet/vscode-csharp
// `src/lsptoolshost/razor/htmlDocument*.ts`; simplified to a plain content provider.

import * as vscode from "vscode";

export const RAZOR_HTML_SCHEME = "razor-html";
const VIRTUAL_HTML_SUFFIX = "__virtual.html";

/** A projected HTML document for one Razor file, served to VS Code's HTML language service. */
export class HtmlDocument {
  private content = "";

  constructor(
    public readonly uri: vscode.Uri,
    public readonly path: string,
    private checksum: string,
  ) {}

  getContent(): string {
    return this.content;
  }

  getChecksum(): string {
    return this.checksum;
  }

  setContent(checksum: string, content: string): void {
    this.checksum = checksum;
    this.content = content;
  }
}

/**
 * Owns the projected HTML documents and exposes them via a `TextDocumentContentProvider` so
 * `vscode.executeXProvider` commands can run the HTML language service against them.
 */
export class HtmlDocumentManager implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, HtmlDocument>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  /** Resolves when VS Code has observed a content change, so LSP calls see fresh content. */
  private readonly pending = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  constructor(
    private readonly caseSensitivePaths: boolean,
    private readonly log: (message: string) => void,
  ) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(RAZOR_HTML_SCHEME, this),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === RAZOR_HTML_SCHEME) {
          const key = getUriPath(e.document.uri);
          this.pending.get(key)?.resolve();
          this.pending.delete(key);
        }
      }),
      // A projected document is only safe to drop once its Razor file is closed.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.languageId === "aspnetcorerazor") {
          this.close(doc.uri);
        }
      }),
      this.changeEmitter,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.find(uri)?.getContent() ?? "";
  }

  /** Applies new generated HTML for a Razor file (creating the projected document on first sight). */
  async updateDocumentText(uri: vscode.Uri, checksum: string, text: string): Promise<void> {
    let doc = this.find(uri);
    if (!doc) {
      doc = this.create(uri, checksum);
      this.docs.set(doc.path, doc);
    }
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.pending.set(doc.path, { promise, resolve });
    await vscode.workspace.openTextDocument(doc.uri);
    doc.setContent(checksum, text);
    this.changeEmitter.fire(doc.uri);
  }

  /**
   * Resolves the projected document for a Razor file before an LSP call. When a `checksum` is given
   * it must match the last update, and we briefly wait for VS Code to have picked up that update so
   * the HTML service sees the right content.
   */
  async getDocument(uri: vscode.Uri, checksum?: string): Promise<HtmlDocument | undefined> {
    const doc = this.find(uri);
    if (!doc) {
      return undefined;
    }
    if (checksum && doc.getChecksum() !== checksum) {
      return undefined;
    }
    await vscode.workspace.openTextDocument(doc.uri);
    if (checksum) {
      const p = this.pending.get(doc.path);
      if (p) {
        try {
          await Promise.race([
            p.promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
        } catch {
          this.log(`Razor: timed out waiting for HTML update of '${doc.path}'.`);
        } finally {
          this.pending.delete(doc.path);
        }
      }
    }
    return doc;
  }

  private close(uri: vscode.Uri): void {
    const doc = this.find(uri);
    if (doc) {
      this.pending.delete(doc.path);
      this.docs.delete(doc.path);
    }
  }

  private find(uri: vscode.Uri): HtmlDocument | undefined {
    const key = this.projectedPath(uri);
    if (this.caseSensitivePaths) {
      return this.docs.get(key);
    }
    for (const doc of this.docs.values()) {
      if (doc.path.localeCompare(key, undefined, { sensitivity: "base" }) === 0) {
        return doc;
      }
    }
    return undefined;
  }

  private projectedPath(uri: vscode.Uri): string {
    const base = getUriPath(uri);
    // A `razor-html:` uri already carries the suffix; a Razor `file:` uri needs it appended.
    return uri.scheme === RAZOR_HTML_SCHEME ? base : `${base}${VIRTUAL_HTML_SUFFIX}`;
  }

  private create(uri: vscode.Uri, checksum: string): HtmlDocument {
    const virtualUri = uri.with({
      scheme: RAZOR_HTML_SCHEME,
      path: `${uri.path}${VIRTUAL_HTML_SUFFIX}`,
    });
    return new HtmlDocument(virtualUri, getUriPath(virtualUri), checksum);
  }
}

/** Normalizes a uri to a stable path key (lower-casing UNC authority, matching vscode-csharp). */
function getUriPath(uri: vscode.Uri): string {
  let normalized = uri;
  if (uri.authority && uri.scheme === "file") {
    normalized = uri.with({ authority: uri.authority.toLowerCase() });
  }
  return normalized.fsPath || normalized.path;
}

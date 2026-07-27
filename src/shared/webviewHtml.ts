// The HTML shell every panel webview shares: CSP with a per-load nonce, stylesheet/script tags
// resolved through `asWebviewUri`, and an inline error boundary.
//
// The boundary is the reason this is worth centralising. If a panel's main script fails to parse,
// the script never runs, so its own error handler cannot fire and the panel just sits blank with no
// clue what went wrong. The inline snippet is parsed separately and runs first, so it survives that
// failure and can report it.

import * as vscode from "vscode";

export interface PanelHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** Document title; also used in the boot-failure message. */
  title: string;
  /** Stylesheet paths below `media/`, e.g. `shared/panel.css`. Order is load order. */
  styles: string[];
  /** Script paths below `media/`. Loaded in order — plain scripts, so later files may use earlier ones. */
  scripts: string[];
}

/**
 * Builds the panel document. Scripts and styles are locked to the nonce and the webview origin;
 * images are limited to bundled assets and data URIs, since panels render no remote content.
 */
export function buildPanelHtml(options: PanelHtmlOptions): string {
  const { webview, extensionUri, title } = options;
  const nonce = makeNonce();
  const asset = (relativePath: string): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...relativePath.split("/")));

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const styleTags = options.styles
    .map((file) => `  <link rel="stylesheet" href="${asset(file)}" nonce="${nonce}" />`)
    .join("\n");
  const scriptTags = options.scripts
    .map((file) => `  <script nonce="${nonce}" src="${asset(file)}"></script>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${styleTags}
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <div id="app" aria-busy="true"></div>
  <script nonce="${nonce}">
    window.addEventListener("error", function (event) {
      var app = document.getElementById("app");
      if (!app) return;
      app.removeAttribute("aria-busy");
      app.textContent = ${JSON.stringify(`${title} failed to load: `)} +
        ((event && event.message) || "unknown error") + ". Please reload the window.";
    });
  </script>
${scriptTags}
</body>
</html>`;
}

/** A per-load script/style nonce. Not a secret — it only has to differ between loads. */
export function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

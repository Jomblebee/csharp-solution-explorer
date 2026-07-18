// A deliberately tiny, safe Markdown -> HTML renderer for package READMEs. NuGet READMEs are
// untrusted third-party content rendered inside a webview, so correctness matters less than safety:
// every text run is HTML-escaped first, only a fixed subset of constructs is emitted, and link/image
// URLs are restricted to http(s). This avoids pulling in a Markdown runtime dependency (OSS rule) and
// keeps the attack surface to what we explicitly produce. Not CommonMark-complete by design.

/** Escapes the five HTML-significant characters so raw README text can never inject markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Allows only http(s) URLs through; anything else (javascript:, data:, …) becomes an empty href.
 * Expects text that `renderInline` has already HTML-escaped, so it must not escape again — a second
 * pass would turn a `&` in a query string into `&amp;amp;` and break the link.
 */
function safeUrl(escapedUrl: string): string {
  const trimmed = escapedUrl.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

/** Renders inline constructs (code, images, links, bold, italic) within an already-block-split line. */
function renderInline(text: string): string {
  // Inline code first: its content is escaped but not further parsed.
  const codeSplit = text.split(/(`[^`]+`)/g);
  return codeSplit
    .map((chunk) => {
      if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length >= 2) {
        return `<code>${escapeHtml(chunk.slice(1, -1))}</code>`;
      }
      let out = escapeHtml(chunk);
      // Images: ![alt](url) — emit only with a safe URL, else drop to the alt text.
      out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
        const safe = safeUrl(url);
        return safe ? `<img src="${safe}" alt="${alt}" />` : alt;
      });
      // Links: [text](url) — emit only with a safe URL, else keep the link text.
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        const safe = safeUrl(url);
        return safe ? `<a href="${safe}">${label}</a>` : label;
      });
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      return out;
    })
    .join("");
}

/**
 * Renders a Markdown subset to HTML: ATX headings (`#`..`######`), fenced code blocks (``` ```),
 * unordered (`-`/`*`) and ordered (`1.`) lists, and paragraphs, plus the inline constructs above.
 * Everything else degrades to escaped paragraph text.
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let inCode = false;
  let codeBuffer: string[] = [];
  let listType: "ul" | "ol" | undefined;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = undefined;
    }
  };

  for (const line of lines) {
    const fence = /^```/.test(line);
    if (fence) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const wanted: "ul" | "ol" = unordered ? "ul" : "ol";
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${renderInline((unordered ?? ordered)![1])}</li>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

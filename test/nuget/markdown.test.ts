import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderMarkdown } from "../../src/nuget/markdown.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("renderMarkdown", () => {
  it("renders ATX headings by level", () => {
    assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
    assert.equal(renderMarkdown("### Deep"), "<h3>Deep</h3>");
  });

  it("wraps loose lines in a paragraph and joins wrapped lines", () => {
    assert.equal(renderMarkdown("one\ntwo"), "<p>one two</p>");
  });

  it("renders unordered and ordered lists", () => {
    assert.equal(renderMarkdown("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    assert.equal(renderMarkdown("1. a\n2. b"), "<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
  });

  it("renders fenced code blocks with escaped content and no inline parsing", () => {
    const out = renderMarkdown("```\n<b>& `x`\n```");
    assert.equal(out, "<pre><code>&lt;b&gt;&amp; `x`</code></pre>");
  });

  it("renders inline code, bold and italic", () => {
    assert.equal(renderMarkdown("use `dotnet`"), "<p>use <code>dotnet</code></p>");
    assert.equal(renderMarkdown("**bold** and *it*"), "<p><strong>bold</strong> and <em>it</em></p>");
  });

  it("keeps only http(s) links and images, dropping unsafe URLs to their text/alt", () => {
    assert.equal(renderMarkdown("[t](https://x.io)"), `<p><a href="https://x.io">t</a></p>`);
    assert.equal(renderMarkdown("[t](javascript:evil)"), "<p>t</p>");
    assert.equal(renderMarkdown("![a](https://x.io/i.png)"), `<p><img src="https://x.io/i.png" alt="a" /></p>`);
    assert.equal(renderMarkdown("![a](data:image/png;base64,xx)"), "<p>a</p>");
  });

  it("escapes raw HTML in ordinary text so READMEs cannot inject markup", () => {
    assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("escapes an ampersand in a URL exactly once", () => {
    // A second escaping pass would emit `&amp;amp;` and send the link to the wrong address.
    assert.equal(
      renderMarkdown("[docs](https://x.io/a?b=1&c=2)"),
      `<p><a href="https://x.io/a?b=1&amp;c=2">docs</a></p>`,
    );
  });

  it("rejects unsafe schemes regardless of casing or surrounding whitespace", () => {
    assert.equal(renderMarkdown("[t](JavaScript:evil)"), "<p>t</p>");
    assert.equal(renderMarkdown("[t](VBScript:evil)"), "<p>t</p>");
    assert.equal(renderMarkdown("![a](JavaScript:evil)"), "<p>a</p>");
    assert.equal(renderMarkdown("[t](//evil.io)"), "<p>t</p>");
    assert.equal(renderMarkdown("[t](/relative/path)"), "<p>t</p>");
  });

  it("cannot break out of the img alt attribute", () => {
    assert.equal(
      renderMarkdown(`![" onerror="alert(1)](https://x.io/i.png)`),
      `<p><img src="https://x.io/i.png" alt="&quot; onerror=&quot;alert(1)" /></p>`,
    );
  });

  it("switches list type without a blank line, closing the first list", () => {
    assert.equal(renderMarkdown("- a\n1. b"), "<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>");
  });

  it("closes an unterminated code fence at end of input", () => {
    assert.equal(renderMarkdown("```\nlet x = 1;"), "<pre><code>let x = 1;</code></pre>");
  });

  it("does not parse markdown inside a code fence", () => {
    assert.equal(
      renderMarkdown("```\n[t](https://x.io) **b**\n```"),
      "<pre><code>[t](https://x.io) **b**</code></pre>",
    );
  });
});

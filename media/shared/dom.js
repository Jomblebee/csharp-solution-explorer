// @ts-check
// Shared webview helpers: a tiny hyperscript builder, a debounce, the host bridge and a toast.
//
// Plain script, no modules — the panels load their files with ordered <script> tags, which keeps the
// CSP surface to a single nonce and needs no loader. Everything lands on `window.CseDom`.
//
// NOTE: `el()` is a copy of the one in media/nugetManager/main.js. That file is 825 untested lines
// and migrating it is not part of this feature; the duplicate is deliberate and should collapse if
// the NuGet panel is ever moved onto this shell.

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /**
   * Builds an element. `class` and `text` are handled specially, `on*` values are attached as
   * listeners, everything else becomes an attribute. Null and undefined props are skipped.
   *
   * @param {string} tag
   * @param {Record<string, any> | null} [props]
   * @param {Array<Node | string | null | undefined>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (key === "class") {
          node.className = value;
        } else if (key === "text") {
          node.textContent = value;
        } else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2), value);
        } else if (value != null && value !== false) {
          node.setAttribute(key, value === true ? "" : value);
        }
      }
    }
    for (const child of children || []) {
      if (child == null) {
        continue;
      }
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  /**
   * Trailing-edge debounce.
   *
   * @param {(...args: any[]) => void} fn
   * @param {number} ms
   * @returns {(...args: any[]) => void}
   */
  function debounce(fn, ms) {
    /** @type {any} */
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /** @param {any} message */
  function post(message) {
    vscode.postMessage(message);
  }

  /** @type {HTMLElement | undefined} */
  let toastEl;
  /** @type {any} */
  let toastTimer;

  /**
   * Transient feedback in the bottom-right corner. Errors linger longer than confirmations, since
   * they are the ones worth reading.
   *
   * @param {string} message
   * @param {boolean} [isError]
   */
  function toast(message, isError) {
    if (!toastEl) {
      toastEl = el("div", { class: "toast" });
      document.body.appendChild(toastEl);
    }
    toastEl.className = isError ? "toast error" : "toast";
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.add("hidden"), isError ? 6000 : 3000);
  }

  /**
   * @param {string} id
   * @returns {HTMLElement | null}
   */
  function byId(id) {
    return document.getElementById(id);
  }

  // @ts-ignore — the namespace is the module boundary between these plain scripts.
  window.CseDom = { el, debounce, post, toast, byId, getState: () => vscode.getState(), setState: (s) => vscode.setState(s) };
})();

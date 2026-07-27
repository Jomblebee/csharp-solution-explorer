// @ts-check
// One widget per EditorKind. Each `renderField` returns the row plus an `update(state)` that
// refreshes the modified marker and the value *without* rebuilding the control — the host echoes
// every write back through onDidChangeConfiguration, and rebuilding would drop the caret mid-word.

(function () {
  "use strict";

  // @ts-ignore
  const { el, debounce } = window.CseDom;

  /** How long to wait after the last keystroke before writing a text value. */
  const TYPING_DEBOUNCE_MS = 500;

  /**
   * @typedef {Object} FieldHandlers
   * @property {(key: string, value: unknown) => void} onChange
   * @property {(key: string) => void} onReset
   * @property {(key: string) => void} onBrowse
   * @property {(key: string) => void} onOpenJson
   */

  /**
   * @param {any} descriptor
   * @param {any} state
   * @param {boolean} readOnly  the Workspace tab for a machine-scoped setting, or no workspace open
   * @param {string | undefined} readOnlyReason
   * @param {FieldHandlers} handlers
   * @returns {{ element: HTMLElement, update: (state: any) => void, matches: (needle: string) => boolean }}
   */
  function renderField(descriptor, state, readOnly, readOnlyReason, handlers) {
    const errorEl = el("div", { class: "field-error hidden" });
    const control = buildControl(descriptor, state, readOnly, handlers, errorEl);

    const resetBtn = el("button", {
      class: "action ghost",
      type: "button",
      title: "Reset to default",
      onclick: () => handlers.onReset(descriptor.key),
      text: "Reset",
    });

    const overriddenBadge = el("span", { class: "badge warn hidden", text: "overridden in workspace" });

    const row = el("div", { class: "field" }, [
      el("div", { class: "field-head" }, [
        el("span", { class: "field-label", text: descriptor.label }),
        el("span", { class: "field-key", text: descriptor.key }),
        overriddenBadge,
      ]),
      descriptor.description ? renderDescription(descriptor.description) : null,
      el("div", { class: "field-control" }, [control.element, el("div", { class: "field-actions" }, [resetBtn])]),
      errorEl,
      readOnly && readOnlyReason ? el("div", { class: "field-note", text: readOnlyReason }) : null,
    ]);

    /** @param {any} next */
    function update(next) {
      row.classList.toggle("modified", Boolean(next.modified));
      resetBtn.disabled = !next.modified || readOnly;
      overriddenBadge.classList.toggle("hidden", !next.overriddenByWorkspace);
      control.setValue(next.effective);
      errorEl.classList.add("hidden");
    }

    update(state);

    // Enum values and their descriptions are visible text in the panel, so search should reach them.
    const haystack = [
      descriptor.key,
      descriptor.label,
      descriptor.description || "",
      (descriptor.enumValues || []).join(" "),
      (descriptor.enumDescriptions || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return { element: row, update, matches: (needle) => haystack.includes(needle) };
  }

  /**
   * Splits a description into nodes, turning `backticked` spans into <code>. Text is always inserted
   * as text nodes — the manifest is ours, but the panel has no reason to grow an HTML path.
   *
   * @param {string} text
   * @returns {Node[]}
   */
  function descriptionNodes(text) {
    const parts = String(text).split("`");
    return parts.map((part, index) => (index % 2 === 1 ? el("code", { text: part }) : document.createTextNode(part)));
  }

  /** @param {string} text */
  function renderDescription(text) {
    return el("p", { class: "field-description" }, descriptionNodes(text));
  }

  /**
   * @param {any} descriptor
   * @param {any} state
   * @param {boolean} readOnly
   * @param {FieldHandlers} handlers
   * @param {HTMLElement} errorEl
   * @returns {{ element: HTMLElement, setValue: (value: unknown) => void }}
   */
  function buildControl(descriptor, state, readOnly, handlers, errorEl) {
    const commit = (/** @type {unknown} */ value) => handlers.onChange(descriptor.key, value);

    switch (descriptor.editor) {
      case "boolean": {
        const input = el("input", {
          type: "checkbox",
          disabled: readOnly,
          "aria-label": descriptor.label,
          onchange: () => commit(input.checked),
        });
        const stateLabel = el("span", { class: "switch-label" });
        const label = el("label", { class: "switch" }, [input, el("span", { class: "track" }), stateLabel]);
        return {
          element: label,
          setValue: (value) => {
            input.checked = value === true;
            stateLabel.textContent = value === true ? "On" : "Off";
          },
        };
      }

      case "enum":
        return buildEnumControl(descriptor, readOnly, commit);

      case "number": {
        const input = el("input", {
          type: "number",
          disabled: readOnly,
          min: descriptor.minimum,
          max: descriptor.maximum,
          oninput: debounce(() => {
            const parsed = Number(input.value);
            if (input.value.trim() === "" || Number.isNaN(parsed)) {
              return showError(errorEl, "Enter a number.");
            }
            hideError(errorEl);
            commit(parsed);
          }, TYPING_DEBOUNCE_MS),
        });
        return {
          element: input,
          setValue: (value) => setIfUnfocused(input, value == null ? "" : String(value)),
        };
      }

      case "string": {
        const input = el("input", {
          type: "text",
          disabled: readOnly,
          oninput: debounce(() => commit(input.value), TYPING_DEBOUNCE_MS),
        });
        const browse = descriptor.pathHint
          ? el("button", {
              class: "action secondary",
              type: "button",
              disabled: readOnly,
              text: "Browse…",
              onclick: () => handlers.onBrowse(descriptor.key),
            })
          : null;
        return {
          element: el("div", { class: "text-control" }, [input, browse]),
          setValue: (value) => setIfUnfocused(input, typeof value === "string" ? value : ""),
        };
      }

      case "multilineString": {
        const textarea = el("textarea", {
          disabled: readOnly,
          spellcheck: "false",
          oninput: debounce(() => commit(textarea.value), TYPING_DEBOUNCE_MS),
        });
        return {
          element: textarea,
          setValue: (value) => setIfUnfocused(textarea, typeof value === "string" ? value : ""),
        };
      }

      case "stringArray": {
        const textarea = el("textarea", {
          disabled: readOnly,
          spellcheck: "false",
          placeholder: "One entry per line",
          oninput: debounce(() => {
            const entries = textarea.value.split("\n").map((line) => line.trim()).filter((line) => line !== "");
            commit(entries);
          }, TYPING_DEBOUNCE_MS),
        });
        return {
          element: textarea,
          setValue: (value) => setIfUnfocused(textarea, Array.isArray(value) ? value.join("\n") : ""),
        };
      }

      case "objectJson": {
        // Validated on blur rather than per keystroke: half-typed JSON is invalid by definition, and
        // an invalid value is never posted.
        const textarea = el("textarea", {
          disabled: readOnly,
          spellcheck: "false",
          onblur: () => {
            try {
              const parsed = JSON.parse(textarea.value);
              hideError(errorEl);
              commit(parsed);
            } catch {
              showError(errorEl, "Not valid JSON — the value was not saved.");
            }
          },
        });
        return {
          element: textarea,
          setValue: (value) => setIfUnfocused(textarea, JSON.stringify(value ?? {}, null, 2)),
        };
      }

      default: {
        const value = el("code", { class: "field-key" });
        return {
          element: el("div", { class: "text-control" }, [
            value,
            el("button", {
              class: "link",
              type: "button",
              text: "Edit in settings.json",
              onclick: () => handlers.onOpenJson(descriptor.key),
            }),
          ]),
          setValue: (v) => {
            value.textContent = JSON.stringify(v);
          },
        };
      }
    }
  }

  /** Gap between the trigger and its popup, and the margin kept to the viewport edges. */
  const POPUP_OFFSET = 4;
  const VIEWPORT_MARGIN = 8;

  /**
   * A dropdown listing every value with its description, the way VS Code's own settings UI does. It
   * is a hand-built listbox rather than a `<select>` because a native option cannot carry a second,
   * dimmed line. Follows the ARIA combobox pattern: focus never leaves the trigger and the
   * highlighted row travels through `aria-activedescendant`.
   *
   * The popup is `position: fixed` so that `.card`'s `overflow: hidden` cannot clip it, but it stays
   * a child of the control so it disappears with the row when the panel re-renders.
   *
   * @param {any} descriptor
   * @param {boolean} readOnly
   * @param {(value: unknown) => void} commit
   * @returns {{ element: HTMLElement, setValue: (value: unknown) => void }}
   */
  function buildEnumControl(descriptor, readOnly, commit) {
    /** @type {string[]} */
    const values = descriptor.enumValues || [];
    /** @type {string[]} */
    const descriptions = descriptor.enumDescriptions || [];
    const baseId = `enum-${String(descriptor.key).replace(/[^A-Za-z0-9_-]/g, "-")}`;

    /** The value the host last told us about — not necessarily one of `values`. */
    let current = "";
    let activeIndex = -1;
    let isOpen = false;

    const triggerValue = el("span", { class: "enum-trigger-value" });
    const trigger = el(
      "button",
      {
        class: "enum-trigger",
        type: "button",
        disabled: readOnly,
        role: "combobox",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": `${baseId}-list`,
        "aria-label": descriptor.label,
        onclick: () => (isOpen ? close(false) : open()),
        onkeydown: onKeyDown,
      },
      [triggerValue, el("span", { class: "enum-chevron", "aria-hidden": "true" })],
    );

    const optionEls = values.map((value, index) =>
      el(
        "div",
        {
          class: "enum-option",
          id: `${baseId}-opt-${index}`,
          role: "option",
          "aria-selected": "false",
          onclick: () => choose(index),
          onmousemove: () => setActive(index),
        },
        [
          el("span", { class: "enum-option-label", text: value }),
          descriptions[index]
            ? el("span", { class: "enum-option-description" }, descriptionNodes(descriptions[index]))
            : null,
        ],
      ),
    );

    const popup = el(
      "div",
      {
        class: "enum-popup hidden",
        id: `${baseId}-list`,
        role: "listbox",
        "aria-label": descriptor.label,
        // Keeps the trigger focused: a mousedown inside the popup would otherwise blur it, and the
        // click that commits the value would arrive at an already-closed widget.
        onmousedown: (/** @type {MouseEvent} */ event) => event.preventDefault(),
      },
      optionEls,
    );

    const hint = el("span", { class: "field-note hidden" });

    /** @param {Event} event */
    function onOutsidePointerDown(event) {
      const target = /** @type {Node} */ (event.target);
      if (!popup.contains(target) && !trigger.contains(target)) {
        close(false);
      }
    }

    /** @param {Event} event */
    function onOutsideScroll(event) {
      // The popup is positioned against the viewport, so it does not follow a scrolling trigger.
      // Scrolling the popup's own list is not that case. A row dropped by a re-render (scope switch)
      // takes its popup with it, so an open widget that is no longer in the document closes too —
      // that is what drops the listeners registered here.
      if (!trigger.isConnected || !popup.contains(/** @type {Node} */ (event.target))) {
        close(false);
      }
    }

    function onViewportChange() {
      close(false);
    }

    function open() {
      if (readOnly || isOpen || values.length === 0) {
        return;
      }
      isOpen = true;
      popup.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      position();
      setActive(Math.max(values.indexOf(current), 0));
      document.addEventListener("pointerdown", onOutsidePointerDown, true);
      document.addEventListener("scroll", onOutsideScroll, true);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("blur", onViewportChange);
    }

    /** @param {boolean} refocus */
    function close(refocus) {
      if (!isOpen) {
        return;
      }
      isOpen = false;
      popup.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (optionEls[activeIndex]) {
        optionEls[activeIndex].classList.remove("active");
      }
      activeIndex = -1;
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      document.removeEventListener("scroll", onOutsideScroll, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
      if (refocus) {
        trigger.focus();
      }
    }

    /** Anchors the popup to the trigger, flipping above it when the space below is too small. */
    function position() {
      const anchor = trigger.getBoundingClientRect();
      popup.style.minWidth = `${anchor.width}px`;
      popup.style.maxHeight = "";

      const below = window.innerHeight - anchor.bottom - POPUP_OFFSET - VIEWPORT_MARGIN;
      const above = anchor.top - POPUP_OFFSET - VIEWPORT_MARGIN;
      const flip = popup.offsetHeight > below && above > below;
      popup.style.maxHeight = `${Math.max(flip ? above : below, 120)}px`;
      popup.style.top = flip
        ? `${anchor.top - popup.offsetHeight - POPUP_OFFSET}px`
        : `${anchor.bottom + POPUP_OFFSET}px`;

      const maxLeft = window.innerWidth - popup.offsetWidth - VIEWPORT_MARGIN;
      popup.style.left = `${Math.max(Math.min(anchor.left, maxLeft), VIEWPORT_MARGIN)}px`;
    }

    /** @param {number} index */
    function setActive(index) {
      if (index < 0 || index >= optionEls.length || index === activeIndex) {
        return;
      }
      if (optionEls[activeIndex]) {
        optionEls[activeIndex].classList.remove("active");
      }
      activeIndex = index;
      const option = optionEls[index];
      option.classList.add("active");
      trigger.setAttribute("aria-activedescendant", option.id);

      // Scrolled by hand rather than with scrollIntoView: the popup is fixed but still sits inside
      // the panel's scroll container, and letting the browser scroll an ancestor would trip the
      // close-on-scroll handler on every arrow key. `offsetTop` is relative to the popup, which is
      // the nearest positioned ancestor.
      const bottom = option.offsetTop + option.offsetHeight;
      if (option.offsetTop < popup.scrollTop) {
        popup.scrollTop = option.offsetTop;
      } else if (bottom > popup.scrollTop + popup.clientHeight) {
        popup.scrollTop = bottom - popup.clientHeight;
      }
    }

    /** @param {number} index */
    function choose(index) {
      const value = values[index];
      close(true);
      if (value === undefined || value === current) {
        return;
      }
      current = value;
      render();
      commit(value);
    }

    /** @param {KeyboardEvent} event */
    function onKeyDown(event) {
      if (!isOpen) {
        if (["ArrowDown", "ArrowUp", "Enter", " ", "Spacebar"].includes(event.key)) {
          event.preventDefault();
          open();
        }
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          setActive(activeIndex + 1);
          break;
        case "ArrowUp":
          setActive(activeIndex - 1);
          break;
        case "Home":
          setActive(0);
          break;
        case "End":
          setActive(optionEls.length - 1);
          break;
        case "Enter":
        case " ":
        case "Spacebar":
          choose(activeIndex);
          break;
        case "Escape":
          close(true);
          break;
        case "Tab":
          // Let the focus move on; only the popup goes away.
          close(false);
          return;
        default:
          return;
      }
      event.preventDefault();
    }

    /** Paints trigger, selection marks and hint from `current`. Never opens or closes the popup. */
    function render() {
      const index = values.indexOf(current);
      // A value outside `enum` reaches us when settings.json was edited by hand; show it rather than
      // snapping the dropdown to something the file does not say.
      triggerValue.textContent = current === "" ? "Not set" : current;
      trigger.classList.toggle("unknown", index < 0);
      optionEls.forEach((option, i) => option.setAttribute("aria-selected", i === index ? "true" : "false"));

      const description = index >= 0 ? descriptions[index] : undefined;
      hint.textContent = description || "";
      hint.classList.toggle("hidden", !description);
    }

    render();

    return {
      element: el("div", { class: "enum-control" }, [trigger, hint, popup]),
      setValue: (value) => {
        current = typeof value === "string" ? value : "";
        render();
      },
    };
  }

  /**
   * Writing into a control the user is typing in would move the caret to the end. The host's echo of
   * our own write is exactly that case, so skip it while focused.
   *
   * @param {any} input
   * @param {string} value
   */
  function setIfUnfocused(input, value) {
    if (document.activeElement !== input) {
      input.value = value;
    }
  }

  /**
   * @param {HTMLElement} errorEl
   * @param {string} message
   */
  function showError(errorEl, message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  /** @param {HTMLElement} errorEl */
  function hideError(errorEl) {
    errorEl.classList.add("hidden");
  }

  // @ts-ignore
  window.CseOptionsFields = { renderField };
})();

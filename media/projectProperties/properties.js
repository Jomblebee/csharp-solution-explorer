// @ts-check
// One row per project property. Each row knows three things the panel's shell does not: which badge its
// origin deserves, whether its control is locked, and which message a commit should send.
//
// The distinction that matters: a *declared* property commits with `setProperty`, while a locked one the
// user chose to edit anyway commits with `overrideProperty` — the host only allows the latter to
// introduce a declaration where there is none, so a stale row cannot overwrite an inherited value by
// pretending it was editable.

(function () {
  "use strict";

  // @ts-ignore
  const { el, debounce } = window.CseDom;

  const TYPING_DEBOUNCE_MS = 500;

  const ORIGIN_LABELS = {
    declared: "Declared here",
    inherited: "Inherited",
    default: "Default",
    conditioned: "Conditional",
    unknown: "Not verified",
  };

  /**
   * @param {any} definition
   * @param {any} status
   * @param {any} handlers  { onSet, onOverride, onClear, onOpenProject, onOpenInherited }
   * @returns {{ element: HTMLElement, update: (status: any) => void }}
   */
  function renderProperty(definition, status, handlers) {
    let current = status;
    /** Set when the user explicitly chose to edit a locked field. */
    let unlocked = false;

    const badge = el("span", { class: "badge" });
    const note = el("div", { class: "field-note" });
    const hint = el("div", { class: "field-note evaluated hidden" });
    const actions = el("div", { class: "field-actions" });

    const control = buildControl(definition, () => commit());
    const row = el("div", { class: "field" }, [
      el("div", { class: "field-head" }, [
        el("span", { class: "field-label", text: definition.label }),
        el("span", { class: "field-key", text: definition.tag }),
        badge,
      ]),
      definition.description ? renderText(definition.description) : null,
      el("div", { class: "field-control" }, [control.element, actions]),
      hint,
      note,
    ]);

    function commit() {
      const value = control.getValue();
      if (current.editable) {
        handlers.onSet(definition.tag, value);
      } else if (unlocked) {
        handlers.onOverride(definition.tag, value);
      }
    }

    /** @param {any} next */
    function update(next) {
      current = next;
      // A fresh status from the host supersedes a local unlock: the field either became editable, or
      // the reason it was locked still stands.
      unlocked = unlocked && !next.editable && next.canOverride;

      const writable = next.editable || unlocked;
      control.setValue(next.value ?? "");
      control.setEnabled(writable);
      row.classList.toggle("locked", !writable);
      row.classList.toggle("declared", next.origin === "declared");

      badge.textContent = ORIGIN_LABELS[next.origin] || next.origin;
      badge.className = `badge origin-${next.origin}`;

      note.textContent = next.note || "";
      note.classList.toggle("hidden", !next.note);

      const showEvaluated = next.evaluated && next.evaluated !== next.value;
      hint.textContent = showEvaluated ? `Evaluates to ${next.evaluated}` : "";
      hint.classList.toggle("hidden", !showEvaluated);

      renderActions(next, writable);
    }

    /**
     * @param {any} next
     * @param {boolean} writable
     */
    function renderActions(next, writable) {
      actions.textContent = "";

      if (next.origin === "declared") {
        actions.appendChild(
          el("button", {
            class: "action ghost",
            type: "button",
            // Deliberately not "Reset to default": removing the project's declaration restores whatever
            // the imports say, which is not always the SDK default.
            text: "Clear",
            title: "Remove this project's declaration and use the inherited or default value",
            onclick: () => handlers.onClear(definition.tag),
          }),
        );
      }

      if (next.origin === "inherited" && !writable) {
        actions.appendChild(
          el("button", {
            class: "action secondary",
            type: "button",
            text: "Override here",
            title: "Add a declaration for this property to this project",
            onclick: () => handlers.onOverride(definition.tag, next.value ?? ""),
          }),
        );
      }

      if (next.origin === "unknown" && !writable) {
        actions.appendChild(
          el("button", {
            class: "action secondary",
            type: "button",
            text: "Edit anyway",
            title: "Add a declaration for this property without waiting for MSBuild",
            onclick: () => {
              unlocked = true;
              update(current);
              control.focus();
            },
          }),
        );
      }

      if (next.origin === "conditioned" || next.origin === "declared") {
        actions.appendChild(
          el("button", {
            class: "link",
            type: "button",
            text: "Show in project file",
            onclick: () => handlers.onOpenProject(next.declaredLine),
          }),
        );
      }

      if (next.inheritedFrom) {
        actions.appendChild(
          el("button", {
            class: "link",
            type: "button",
            text: fileName(next.inheritedFrom.fsPath),
            title: next.inheritedFrom.fsPath,
            onclick: () => handlers.onOpenInherited(next.inheritedFrom.fsPath, next.inheritedFrom.line),
          }),
        );
      }
    }

    update(status);
    return { element: row, update };
  }

  /**
   * @param {any} definition
   * @param {() => void} commit
   */
  function buildControl(definition, commit) {
    if (definition.editor === "boolean") {
      const input = el("input", { type: "checkbox", "aria-label": definition.label, onchange: commit });
      const stateLabel = el("span", { class: "switch-label" });
      return {
        element: el("label", { class: "switch" }, [input, el("span", { class: "track" }), stateLabel]),
        getValue: () => (input.checked ? "true" : "false"),
        setValue: (/** @type {string} */ value) => {
          const on = String(value).toLowerCase() === "true";
          input.checked = on;
          stateLabel.textContent = on ? "true" : "false";
        },
        setEnabled: (/** @type {boolean} */ enabled) => {
          input.disabled = !enabled;
        },
        focus: () => input.focus(),
      };
    }

    if (definition.editor === "enum") {
      // An empty option is offered because "not set" is a legitimate state the SDK fills in.
      const select = el(
        "select",
        { onchange: commit },
        [el("option", { value: "", text: "(not set)" })].concat(
          (definition.values || []).map((/** @type {string} */ value) => el("option", { value, text: value })),
        ),
      );
      return {
        element: select,
        getValue: () => select.value,
        setValue: (/** @type {string} */ value) => {
          select.value = matchOption(select, value);
        },
        setEnabled: (/** @type {boolean} */ enabled) => {
          select.disabled = !enabled;
        },
        focus: () => select.focus(),
      };
    }

    const input = el("input", {
      type: "text",
      placeholder: definition.placeholder ? `default: ${definition.placeholder}` : "",
      oninput: debounce(commit, TYPING_DEBOUNCE_MS),
      onblur: commit,
    });
    const wrapper =
      definition.editor === "frameworks"
        ? el("div", { class: "text-control" }, [
            input,
            el("span", { class: "field-note", text: "Separate several with ;" }),
          ])
        : input;
    return {
      element: wrapper,
      getValue: () => input.value.trim(),
      setValue: (/** @type {string} */ value) => {
        if (document.activeElement !== input) {
          input.value = value;
        }
      },
      setEnabled: (/** @type {boolean} */ enabled) => {
        input.disabled = !enabled;
      },
      focus: () => input.focus(),
    };
  }

  /** Keeps a value the project declares that is not one of the catalogue's options. */
  function matchOption(select, value) {
    const wanted = String(value ?? "");
    for (const option of select.options) {
      if (option.value.toLowerCase() === wanted.toLowerCase()) {
        return option.value;
      }
    }
    if (wanted !== "") {
      select.appendChild(el("option", { value: wanted, text: `${wanted} (from the project file)` }));
    }
    return wanted;
  }

  /** Renders text with `backticked` spans as code, without an HTML path. */
  function renderText(text) {
    const parts = String(text).split("`");
    return el(
      "p",
      { class: "field-description" },
      parts.map((part, index) => (index % 2 === 1 ? el("code", { text: part }) : document.createTextNode(part))),
    );
  }

  function fileName(fsPath) {
    return String(fsPath).split(/[\\/]/).pop();
  }

  // @ts-ignore
  window.CseProps = { renderProperty };
})();

// @ts-check
// The launch-profiles card: Visual Studio's Debug page over Properties/launchSettings.json.
//
// Rebuilt wholesale on every update rather than diffed. Profiles are added, renamed and deleted, so a
// stable row identity would buy little — and a rebuild cannot leave a row bound to a profile that no
// longer exists. The one cost is the caret, which is why every text field commits on blur or Enter
// rather than while typing.

(function () {
  "use strict";

  // @ts-ignore
  const { el } = window.CseDom;

  const COMMAND_NAMES = ["Project", "Executable", "IISExpress"];

  const TEXT_FIELDS = [
    { field: "commandLineArgs", label: "Arguments", placeholder: "--flag value" },
    { field: "workingDirectory", label: "Working directory", placeholder: "the project directory" },
    { field: "applicationUrl", label: "Application URL", placeholder: "https://localhost:7001;http://localhost:5001" },
    { field: "launchUrl", label: "Launch URL", placeholder: "swagger" },
    { field: "executablePath", label: "Executable", placeholder: "" },
  ];

  /**
   * @param {Array<any>} profiles
   * @param {any} handlers
   * @returns {HTMLElement}
   */
  function renderProfiles(profiles, handlers) {
    const body = el(
      "div",
      { class: "card-body" },
      profiles.length === 0
        ? [el("div", { class: "empty", text: "This project has no launch profiles." })]
        : profiles.map((profile) => renderProfile(profile, handlers)),
    );

    return el("section", { class: "card" }, [
      el("div", { class: "card-header" }, [
        el("h2", { class: "card-title", text: "Launch profiles" }),
        el("span", { class: "card-count", text: "Properties/launchSettings.json" }),
        el("div", { class: "panel-spacer" }),
        el("button", {
          class: "action secondary",
          type: "button",
          text: "Add profile",
          onclick: () => handlers.onAdd(),
        }),
        el("button", {
          class: "link",
          type: "button",
          text: "Open file",
          onclick: () => handlers.onOpenFile(),
        }),
      ]),
      body,
    ]);
  }

  function renderProfile(profile, handlers) {
    const isExecutable = String(profile.commandName).toLowerCase() === "executable";

    const fields = TEXT_FIELDS.filter((entry) => entry.field !== "executablePath" || isExecutable).map((entry) =>
      renderTextField(profile, entry, handlers),
    );

    return el("details", { class: "profile", open: profile.name ? undefined : true }, [
      el("summary", { class: "profile-summary" }, [
        el("span", { class: "field-label", text: profile.name }),
        el("span", { class: "badge", text: profile.commandName }),
        profile.applicationUrl ? el("span", { class: "field-key", text: profile.applicationUrl }) : null,
      ]),
      el("div", { class: "profile-body" }, [
        renderCommandName(profile, handlers),
        ...fields,
        renderFlag(profile, "launchBrowser", "Open a browser on start", handlers),
        renderFlag(profile, "dotnetRunMessages", "Show dotnet run messages", handlers),
        renderEnvironment(profile, handlers),
        el("div", { class: "profile-actions" }, [
          el("button", {
            class: "action ghost",
            type: "button",
            text: "Rename",
            onclick: () => handlers.onRename(profile.name),
          }),
          el("button", {
            class: "action ghost",
            type: "button",
            text: "Duplicate",
            onclick: () => handlers.onDuplicate(profile.name),
          }),
          el("button", {
            class: "action ghost danger",
            type: "button",
            text: "Delete",
            onclick: () => handlers.onDelete(profile.name),
          }),
        ]),
      ]),
    ]);
  }

  function renderCommandName(profile, handlers) {
    const select = el(
      "select",
      { onchange: () => handlers.onText(profile.name, "commandName", select.value) },
      COMMAND_NAMES.concat(
        COMMAND_NAMES.includes(profile.commandName) ? [] : [profile.commandName],
      ).map((value) => el("option", { value, text: value })),
    );
    select.value = profile.commandName;
    return row("Launch", select);
  }

  function renderTextField(profile, entry, handlers) {
    const input = el("input", {
      type: "text",
      value: profile[entry.field] || "",
      placeholder: entry.placeholder ? `default: ${entry.placeholder}` : "",
      // Committing on blur and Enter, not per keystroke: every write re-serialises the whole file.
      onblur: () => commit(),
      onkeydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === "Enter") {
          commit();
        }
      },
    });
    function commit() {
      const value = input.value;
      if (value !== (profile[entry.field] || "")) {
        handlers.onText(profile.name, entry.field, value);
      }
    }
    return row(entry.label, input);
  }

  function renderFlag(profile, field, label, handlers) {
    const input = el("input", {
      type: "checkbox",
      "aria-label": label,
      onchange: () => handlers.onFlag(profile.name, field, input.checked),
    });
    input.checked = Boolean(profile[field]);
    return row(
      label,
      el("label", { class: "switch" }, [input, el("span", { class: "track" })]),
    );
  }

  /**
   * Environment variables as `KEY=value` lines. A table with per-row buttons reads better but makes
   * bulk edits (the common case when copying settings between profiles) tedious.
   */
  function renderEnvironment(profile, handlers) {
    const text = Object.entries(profile.environmentVariables || {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const textarea = el("textarea", {
      spellcheck: "false",
      placeholder: "ASPNETCORE_ENVIRONMENT=Development",
      onblur: () => {
        const parsed = parseEnvironment(textarea.value);
        if (!sameEnvironment(parsed, profile.environmentVariables || {})) {
          handlers.onEnvironment(profile.name, parsed);
        }
      },
    });
    textarea.value = text;
    return row("Environment variables", textarea, "One KEY=value per line.");
  }

  /** Lines without `=` are dropped rather than stored as empty-valued keys. */
  function parseEnvironment(text) {
    /** @type {Record<string, string>} */
    const result = {};
    for (const line of String(text).split("\n")) {
      const index = line.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const key = line.slice(0, index).trim();
      if (key !== "") {
        result[key] = line.slice(index + 1).trim();
      }
    }
    return result;
  }

  function sameEnvironment(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
  }

  function row(label, control, note) {
    return el("div", { class: "field profile-field" }, [
      el("div", { class: "field-head" }, [el("span", { class: "field-label", text: label })]),
      el("div", { class: "field-control" }, [control]),
      note ? el("div", { class: "field-note", text: note }) : null,
    ]);
  }

  // @ts-ignore
  window.CseProfiles = { renderProfiles };
})();

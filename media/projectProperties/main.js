// @ts-check
// The Project Properties panel webview: a card per section, a row per property, and a header carrying
// the project name and — for multi-targeted projects — the framework the values are evaluated for.
//
// Rows are built once from the catalogue and then only updated, so a background evaluation arriving
// while the user types does not rebuild the control under the caret.

(function () {
  "use strict";

  // @ts-ignore
  const { el, post, toast, byId, setState, getState } = window.CseDom;
  // @ts-ignore
  const { renderProperty } = window.CseProps;
  // @ts-ignore
  const { renderProfiles } = window.CseProfiles;

  const state = {
    /** @type {Array<any>} */
    sections: [],
    /** @type {Array<any>} */
    definitions: [],
    /** @type {any} */
    project: undefined,
    /** @type {string[]} */
    frameworks: [],
    /** @type {string | undefined} */
    selectedFramework: undefined,
    evaluating: false,
    /** @type {Array<any>} */
    profiles: [],
  };

  /** @type {Map<string, {element: HTMLElement, update: (status: any) => void}>} */
  const rows = new Map();
  /** @type {HTMLElement | null} */
  let statusEl = null;
  /** @type {HTMLElement | null} */
  let frameworkSelect = null;
  /** @type {HTMLElement | null} */
  let profilesHost = null;

  const handlers = {
    onSet: (/** @type {string} */ tag, /** @type {string} */ value) => post({ type: "setProperty", tag, value }),
    onOverride: (/** @type {string} */ tag, /** @type {string} */ value) =>
      post({ type: "overrideProperty", tag, value }),
    onClear: (/** @type {string} */ tag) => post({ type: "clearProperty", tag }),
    onOpenProject: (/** @type {number | undefined} */ line) => post({ type: "openProjectFile", line }),
    onOpenInherited: (/** @type {string} */ fsPath, /** @type {number | undefined} */ line) =>
      post({ type: "openInheritedFile", fsPath, line }),
  };

  // Naming and deleting go to the host, which owns the dialogs and the duplicate-name check.
  const profileHandlers = {
    onAdd: () => post({ type: "profileAdd" }),
    onDuplicate: (/** @type {string} */ source) => post({ type: "profileDuplicate", source }),
    onRename: (/** @type {string} */ name) => post({ type: "profileRename", name }),
    onDelete: (/** @type {string} */ name) => post({ type: "profileDelete", name }),
    onText: (/** @type {string} */ name, /** @type {string} */ field, /** @type {string} */ value) =>
      post({ type: "profileText", name, field, value }),
    onFlag: (/** @type {string} */ name, /** @type {string} */ field, /** @type {boolean} */ value) =>
      post({ type: "profileFlag", name, field, value }),
    onEnvironment: (/** @type {string} */ name, /** @type {Record<string, string>} */ environment) =>
      post({ type: "profileEnvironment", name, environment }),
    onOpenFile: () => post({ type: "openLaunchSettings" }),
  };

  function buildShell() {
    const app = byId("app");
    if (!app) {
      return;
    }
    app.textContent = "";
    app.removeAttribute("aria-busy");

    statusEl = el("span", { class: "panel-subtitle" });

    const toolbar = el("div", { class: "panel-toolbar" }, [
      el("h1", { class: "panel-title", text: state.project ? state.project.name : "Project" }),
      el("span", { class: "panel-subtitle", text: state.project ? sdkLabel(state.project) : "" }),
      buildFrameworkPicker(),
      statusEl,
      el("div", { class: "panel-spacer" }),
      el("button", {
        class: "action secondary",
        type: "button",
        text: "Open project file",
        onclick: () => post({ type: "openProjectFile" }),
      }),
      el("button", {
        class: "action secondary",
        type: "button",
        text: "Refresh",
        onclick: () => post({ type: "refresh" }),
      }),
    ]);

    profilesHost = el("div", { class: "profiles-host" });
    const content = el("div", { class: "panel-content" }, [
      el("div", { class: "panel-content-inner" }, buildSections().concat([profilesHost])),
    ]);

    app.appendChild(toolbar);
    app.appendChild(el("div", { class: "panel-body" }, [content]));
    // The shell can be rebuilt after the profiles arrived, so they are re-rendered from state rather
    // than waiting for the next push.
    renderProfilesSection();
  }

  function renderProfilesSection() {
    if (!profilesHost) {
      return;
    }
    profilesHost.textContent = "";
    profilesHost.appendChild(renderProfiles(state.profiles, profileHandlers));
  }

  function buildFrameworkPicker() {
    if (state.frameworks.length < 2) {
      // A single-targeted project has nothing to choose, and MSBuild needs no framework to evaluate it.
      return null;
    }
    frameworkSelect = el(
      "select",
      {
        "aria-label": "Target framework to evaluate",
        onchange: () => post({ type: "selectFramework", framework: frameworkSelect.value }),
      },
      state.frameworks.map((framework) => el("option", { value: framework, text: framework })),
    );
    if (state.selectedFramework) {
      frameworkSelect.value = state.selectedFramework;
    }
    return el("label", { class: "framework-picker" }, [
      el("span", { class: "panel-subtitle", text: "Evaluating" }),
      frameworkSelect,
    ]);
  }

  function buildSections() {
    rows.clear();
    return state.sections.map((section) => {
      const definitions = state.definitions.filter((definition) => definition.section === section.id);
      const fields = definitions.map((definition) => {
        const row = renderProperty(definition, placeholderStatus(definition), handlers);
        rows.set(definition.tag, row);
        return row.element;
      });
      return el("section", { class: "card" }, [
        el("div", { class: "card-header" }, [
          el("h2", { class: "card-title", text: section.title }),
          el("span", { class: "card-count", text: section.description }),
        ]),
        el("div", { class: "card-body" }, fields),
      ]);
    });
  }

  /** Until the host's first state arrives, every field is locked and says so. */
  function placeholderStatus(definition) {
    return { tag: definition.tag, origin: "unknown", value: "", editable: false, canOverride: false };
  }

  /** @param {Array<any>} properties */
  function applyProperties(properties) {
    for (const status of properties) {
      rows.get(status.tag)?.update(status);
    }
  }

  /** @param {boolean} evaluating */
  function setEvaluating(evaluating, available) {
    state.evaluating = evaluating;
    if (!statusEl) {
      return;
    }
    if (evaluating) {
      statusEl.textContent = "Evaluating with MSBuild…";
    } else if (available === false) {
      statusEl.textContent = "MSBuild did not answer — undeclared properties stay locked.";
    } else {
      statusEl.textContent = "";
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "catalog":
        state.sections = message.sections;
        state.definitions = message.definitions;
        break;

      case "projectState": {
        const next = message.state;
        const rebuild =
          !state.project ||
          state.frameworks.join(";") !== next.frameworks.join(";") ||
          rows.size === 0;
        state.project = next.project;
        state.frameworks = next.frameworks;
        state.selectedFramework = next.selectedFramework;
        if (rebuild) {
          buildShell();
        }
        setEvaluating(message.evaluating, true);
        applyProperties(next.properties);
        setState({ projectFsPath: next.project.fsPath, framework: next.selectedFramework });
        break;
      }

      case "profiles":
        state.profiles = message.profiles;
        renderProfilesSection();
        break;

      case "evaluated":
        setEvaluating(false, message.available);
        if (message.available) {
          applyProperties(message.properties);
        }
        break;

      case "writeResult":
        applyProperties(message.properties);
        if (message.report.message) {
          toast(message.report.message, String(message.report.outcome).startsWith("refused"));
        } else if (message.report.outcome === "removed") {
          toast("Cleared — showing the inherited or default value.");
        }
        break;

      case "externalChange":
        toast("The project file changed outside this panel; reloaded.");
        break;

      case "error":
        toast(message.message, true);
        break;
    }
  });

  function sdkLabel(project) {
    return project.sdk ? project.sdk : "";
  }

  const persisted = getState();
  post({ type: "ready", framework: persisted && persisted.framework });
})();

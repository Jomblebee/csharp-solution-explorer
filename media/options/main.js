// @ts-check
// The Options panel webview: builds the shell, renders one card per setting group, and keeps the
// rows in sync with what the host reports.
//
// The host is the only thing that reads or writes settings. This side sends intent (`update`,
// `reset`, `setScope`) and renders whatever comes back — it never assumes a write succeeded.

(function () {
  "use strict";

  // @ts-ignore
  const { el, debounce, post, toast, byId, setState } = window.CseDom;
  // @ts-ignore
  const { renderField } = window.CseOptionsFields;
  // @ts-ignore
  const { renderNav, observeSections } = window.CseOptionsNav;

  const state = {
    /** @type {Array<any>} */
    groups: [],
    /** @type {"user" | "workspace"} */
    scope: "user",
    hasWorkspace: false,
    /** @type {string | undefined} */
    workspaceLabel: undefined,
    /** @type {Record<string, any>} */
    values: {},
    query: "",
  };

  /** @type {Map<string, {element: HTMLElement, update: (state: any) => void, matches: (needle: string) => boolean}>} */
  const fields = new Map();
  /** @type {Array<{id: string, element: HTMLElement}>} */
  let sections = [];
  /** @type {any} */
  let nav;
  /** @type {HTMLElement | null} */
  let contentEl = null;
  /** @type {HTMLElement | null} */
  let innerEl = null;
  /** @type {{ dispose: () => void } | undefined} */
  let sectionWatcher;
  /** Set while a scope switch is in flight, so the rebuild waits for that scope's values. */
  let awaitingScopeValues = false;
  /** @type {HTMLElement | null} */
  let userTab = null;
  /** @type {HTMLElement | null} */
  let workspaceTab = null;

  const handlers = {
    /**
     * @param {string} key
     * @param {unknown} value
     */
    onChange: (key, value) => post({ type: "update", key, scope: state.scope, value }),
    /** @param {string} key */
    onReset: (key) => post({ type: "reset", key, scope: state.scope }),
    /** @param {string} key */
    onBrowse: (key) => post({ type: "browse", key, scope: state.scope }),
    /** @param {string} key */
    onOpenJson: (key) => post({ type: "openJson", scope: state.scope, key }),
  };

  function buildShell() {
    const app = byId("app");
    if (!app) {
      return;
    }
    app.textContent = "";
    app.removeAttribute("aria-busy");

    userTab = el("button", {
      class: state.scope === "user" ? "tab active" : "tab",
      type: "button",
      text: "User",
      onclick: () => switchScope("user"),
    });
    workspaceTab = el("button", {
      class: state.scope === "workspace" ? "tab active" : "tab",
      type: "button",
      text: "Workspace",
      disabled: !state.hasWorkspace,
      title: state.hasWorkspace ? state.workspaceLabel : "No folder is open, so there is nowhere to store workspace settings.",
      onclick: () => switchScope("workspace"),
    });

    const search = el("input", {
      type: "text",
      class: "search-input",
      placeholder: "Search settings",
      "aria-label": "Search settings",
      oninput: debounce(() => {
        state.query = search.value.trim().toLowerCase();
        applyFilter();
      }, 200),
    });

    const toolbar = el("div", { class: "panel-toolbar" }, [
      el("h1", { class: "panel-title", text: "C# Solution Explorer" }),
      el("span", { class: "panel-subtitle", text: "Options" }),
      el("div", { class: "tabs", role: "tablist" }, [userTab, workspaceTab]),
      search,
      el("div", { class: "panel-spacer" }),
      el("button", {
        class: "action secondary",
        type: "button",
        text: "settings.json",
        title: "Open the underlying settings.json",
        onclick: () => post({ type: "openJson", scope: state.scope }),
      }),
      el("button", {
        class: "action secondary",
        type: "button",
        text: "Settings UI",
        title: "Open these settings in the built-in Settings editor",
        onclick: () => post({ type: "openNativeSettings" }),
      }),
    ]);

    innerEl = el("div", { class: "panel-content-inner" }, buildSections());
    contentEl = el("div", { class: "panel-content" }, [innerEl]);
    nav = renderNav(state.groups, scrollToGroup);

    app.appendChild(toolbar);
    app.appendChild(el("div", { class: "panel-body" }, [nav.element, contentEl]));
    observeCurrentSections();
  }

  /**
   * Rebuilds the cards without touching the toolbar. A scope switch changes which rows are writable,
   * and rebuilding the whole shell would clear the search box the user just typed in.
   */
  function rebuildContent() {
    if (!innerEl) {
      return;
    }
    innerEl.textContent = "";
    for (const section of buildSections()) {
      innerEl.appendChild(section);
    }
    applyFilter();
    observeCurrentSections();
  }

  function observeCurrentSections() {
    sectionWatcher?.dispose();
    if (contentEl) {
      sectionWatcher = observeSections(contentEl, sections, (id) => nav.setActive(id));
    }
  }

  function buildSections() {
    fields.clear();
    sections = [];
    const readOnly = state.scope === "workspace" && !state.hasWorkspace;

    return state.groups.map((group) => {
      const rows = group.settings.map((/** @type {any} */ descriptor) => {
        const rowReadOnly = readOnly || (state.scope === "workspace" && descriptor.userOnly);
        const reason = rowReadOnly
          ? descriptor.userOnly
            ? "This setting applies to the whole machine and cannot be set per workspace."
            : "No folder is open."
          : undefined;
        const field = renderField(
          descriptor,
          state.values[descriptor.key] || { effective: descriptor.default, modified: false, default: descriptor.default },
          rowReadOnly,
          reason,
          handlers,
        );
        fields.set(descriptor.key, field);
        return field.element;
      });

      const section = el("section", { class: "card", id: `group-${group.id}` }, [
        el("div", { class: "card-header" }, [
          el("h2", { class: "card-title", text: group.title }),
          el("span", { class: "card-count", text: `${group.settings.length} settings` }),
        ]),
        el("div", { class: "card-body" }, rows),
      ]);
      sections.push({ id: group.id, element: section });
      return section;
    });
  }

  /** @param {"user" | "workspace"} scope */
  function switchScope(scope) {
    if (state.scope === scope || (scope === "workspace" && !state.hasWorkspace)) {
      return;
    }
    state.scope = scope;
    setState({ scope });
    userTab?.classList.toggle("active", scope === "user");
    workspaceTab?.classList.toggle("active", scope === "workspace");
    // The rows stay on screen until the new scope's values arrive. Rebuilding now would show the
    // previous scope's values — and its modified markers — under the tab the user just left.
    awaitingScopeValues = true;
    post({ type: "setScope", scope });
  }

  /** @param {string} groupId */
  function scrollToGroup(groupId) {
    const target = byId(`group-${groupId}`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    nav.setActive(groupId);
  }

  /** Filters rows and sections in place — no host round-trip, and no rebuild of the controls. */
  function applyFilter() {
    const needle = state.query;
    /** @type {Set<string>} */
    const visibleGroups = new Set();

    for (const group of state.groups) {
      let visibleCount = 0;
      for (const descriptor of group.settings) {
        const field = fields.get(descriptor.key);
        if (!field) {
          continue;
        }
        const visible = needle === "" || field.matches(needle);
        field.element.classList.toggle("hidden", !visible);
        if (visible) {
          visibleCount++;
        }
      }
      const section = sections.find((entry) => entry.id === group.id);
      section?.element.classList.toggle("hidden", visibleCount === 0);
      if (visibleCount > 0) {
        visibleGroups.add(group.id);
      }
    }

    nav.setVisible(visibleGroups);
  }

  /** Refreshes the existing rows in place, leaving a focused control's text alone. */
  function applyValues(/** @type {Record<string, any>} */ values) {
    for (const [key, field] of fields) {
      field.update(values[key] || { effective: undefined, modified: false });
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "schema":
        state.groups = message.groups;
        state.hasWorkspace = message.hasWorkspace;
        state.workspaceLabel = message.workspaceLabel;
        if (!state.hasWorkspace) {
          state.scope = "user";
        }
        buildShell();
        applyFilter();
        break;

      case "values":
        if (message.scope !== state.scope) {
          break; // a stale snapshot from before a scope switch
        }
        state.values = message.values;
        if (awaitingScopeValues) {
          // Which rows are writable depends on the scope, so the controls themselves are rebuilt.
          awaitingScopeValues = false;
          rebuildContent();
        } else {
          applyValues(message.values);
        }
        break;

      case "updated": {
        if (message.scope !== state.scope) {
          break;
        }
        state.values[message.key] = message.state;
        fields.get(message.key)?.update(message.state);
        break;
      }

      case "error":
        toast(message.message, true);
        break;
    }
  });

  // A restored webview keeps the tab the user was on.
  // @ts-ignore
  const persisted = window.CseDom.getState();
  if (persisted && persisted.scope === "workspace") {
    state.scope = "workspace";
  }

  post({ type: "ready", scope: state.scope });
})();

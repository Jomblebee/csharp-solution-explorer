// @ts-check
// Webview client for the NuGet package manager. Pure vanilla DOM — no framework, no external code
// (CSP forbids it). All third-party text is inserted via textContent; only the extension-sanitized
// README arrives as HTML and is injected into an isolated container.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  /** @typedef {{ id: string, version: string }} InstalledPackage */
  /** @typedef {{ name: string, fsPath: string, relativePath: string, packages: InstalledPackage[] }} ProjectState */
  /** @typedef {{ solutionName: string, projects: ProjectState[], centralPackageManagement?: { propsPath: string } }} SolutionState */

  const app = document.getElementById("app");
  const state = {
    /** @type {SolutionState} */
    solution: { solutionName: "", projects: [] },
    /** @type {Set<string>} */
    checked: new Set(),
    tab: "browse",
    prerelease: false,
    query: "",
    /** @type {any[]} */
    results: [],
    /** @type {any[]} */
    updates: [],
    /** @type {{ id: string, versions: string[], projects: number }[]} — pushed by the extension. */
    installed: [],
    /** @type {{ id: string, versions: { version: string, projects: any[] }[] }[]} — pushed too. */
    consolidate: [],
    /** @type {string|null} */
    selectedId: null,
    /** @type {string|null} */
    selectedVersion: null,
    /** @type {any} */
    details: null,
    loadingDetails: false,
    // Monotonic ids for the two request/response pairs that can overtake each other: rapid version
    // switches on one package, and a re-run of the *same* query when "Include prerelease" is toggled.
    // Only the response carrying the current id is rendered.
    searchRequestId: 0,
    detailsRequestId: 0,
    /** @type {{ op: string }|null} — set while a package operation is running, drives the busy UI. */
    busy: null,
    /** True while a manual refresh (solution state + update check) is in flight. */
    refreshing: false,
  };

  function isBusy() {
    return !!state.busy;
  }

  // ---- tiny DOM helpers ----
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        if (key === "class") node.className = props[key];
        else if (key === "text") node.textContent = props[key];
        else if (key.startsWith("on") && typeof props[key] === "function") {
          node.addEventListener(key.slice(2), props[key]);
        } else if (props[key] != null) node.setAttribute(key, props[key]);
      }
    }
    for (const child of children || []) {
      if (child == null) continue;
      if (typeof child === "string") node.appendChild(document.createTextNode(child));
      else if (child instanceof Node) node.appendChild(child);
      else node.appendChild(document.createTextNode(String(child)));
    }
    return node;
  }

  function sanitizeIconUrl(url) {
    if (typeof url !== "string" || !url.trim()) return null;
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.href;
      }
    } catch (_) {
      // Invalid URL, fall through to null.
    }
    return null;
  }

  function icon(url, cls) {
    const img = el("img", { class: cls || "icon", alt: "" });
    const safeUrl = sanitizeIconUrl(url);
    if (safeUrl) {
      img.src = safeUrl;
      img.addEventListener("error", () => (img.style.visibility = "hidden"));
    } else {
      img.style.visibility = "hidden";
    }
    return img;
  }

  // ---- deprecation / vulnerability badges ----
  const SEVERITY_LABELS = ["Low", "Moderate", "High", "Critical"];

  /** The worst severity in a list of advisories, used to label the collapsed badge. */
  function worstSeverity(vulnerabilities) {
    return vulnerabilities.reduce((worst, v) => Math.max(worst, v.severity || 0), 0);
  }

  /**
   * One badge summarising a package version's advisories, or null when there are none. The badge
   * links to the highest-severity advisory; the title lists them all, since a package can carry
   * several and the row has no space for more than a count.
   */
  function vulnerabilityBadge(vulnerabilities) {
    if (!vulnerabilities || !vulnerabilities.length) return null;
    const severity = worstSeverity(vulnerabilities);
    const label = SEVERITY_LABELS[severity] || "Unknown";
    const count = vulnerabilities.length;
    const worst = vulnerabilities.find((v) => (v.severity || 0) === severity);
    const badge = el("span", {
      class: "badge vulnerable",
      title: vulnerabilities.map((v) => (SEVERITY_LABELS[v.severity || 0] || "Unknown") + ": " + v.advisoryUrl).join("\n"),
      text: "⚠ " + (count > 1 ? count + " vulnerabilities" : "Vulnerability") + " · " + label,
    });
    if (worst) {
      badge.classList.add("clickable");
      badge.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also select the row behind the badge
        post({ type: "openExternal", url: worst.advisoryUrl });
      });
    }
    return badge;
  }

  /** Badge for a deprecated version, naming the replacement package when the author supplied one. */
  function deprecationBadge(deprecation) {
    if (!deprecation) return null;
    const reasons = (deprecation.reasons || []).join(", ");
    let text = "⚠ Deprecated";
    if (reasons) text += " · " + reasons;
    if (deprecation.alternatePackageId) text += " → use " + deprecation.alternatePackageId;
    return el("span", { class: "badge deprecated", title: deprecation.message || "", text });
  }

  function formatDownloads(n) {
    if (!n) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M downloads";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K downloads";
    return n + " downloads";
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  // The installed/consolidate lists are computed by the extension (where `compareVersions` lives and
  // where the code is type-checked and tested) and pushed alongside the solution state. This lookup
  // stays here because it only feeds the "v1.2.3 / —" column of the project checklist; which projects
  // an operation actually touches is decided host-side.
  function installedVersionInProject(project, id) {
    const lower = id.toLowerCase();
    const hit = project.packages.find((p) => p.id.toLowerCase() === lower);
    return hit ? hit.version : undefined;
  }

  // ---- shell ----
  let listEl, detailEl, searchInput, prereleaseInput, tabButtons, browseBadgeEls, refreshBtn;

  function buildShell() {
    app.textContent = "";
    app.removeAttribute("aria-busy");

    tabButtons = {};
    browseBadgeEls = {};
    const makeTab = (id, label) => {
      const badge = el("span", { class: "badge hidden" });
      browseBadgeEls[id] = badge;
      const btn = el("button", { class: "tab", onclick: () => setTab(id) }, [label, badge]);
      tabButtons[id] = btn;
      return btn;
    };

    const tabs = el("div", { class: "tabs" }, [
      makeTab("browse", "Browse"),
      makeTab("installed", "Installed"),
      makeTab("updates", "Updates"),
      makeTab("consolidate", "Consolidate"),
    ]);

    searchInput = el("input", {
      type: "search",
      placeholder: "Search nuget.org…",
      oninput: onSearchInput,
    });
    prereleaseInput = el("input", { type: "checkbox", onchange: onPrereleaseToggle });
    const search = el("div", { class: "search" }, [
      searchInput,
      el("label", { class: "prerelease" }, [prereleaseInput, "Include prerelease"]),
    ]);

    const solutionName = el("span", {
      class: "solution-name",
      text: state.solution.solutionName ? "Solution: " + state.solution.solutionName : "",
    });

    refreshBtn = el("button", {
      class: "refresh",
      title: "Reload installed packages and check nuget.org for updates",
      "aria-label": "Refresh",
      onclick: refreshAll,
    }, [el("span", { class: "glyph", text: "⟳" }), el("span", { class: "label", text: "Refresh" })]);

    const toolbar = el("div", { class: "toolbar" }, [tabs, search, solutionName, refreshBtn]);

    listEl = el("div", { class: "list" });
    detailEl = el("div", { class: "detail" });
    const split = el("div", { class: "split" }, [listEl, detailEl]);

    app.appendChild(toolbar);
    const banner = centralPackageManagementBanner();
    if (banner) app.appendChild(banner);
    app.appendChild(split);
    renderTabs();
  }

  /** True when versions come from a Directory.Packages.props, which makes this panel read-only. */
  function isCentrallyManaged() {
    return !!state.solution.centralPackageManagement;
  }

  /**
   * Explains why the write actions are disabled. Browsing, details, READMEs and the Updates overview
   * all keep working — only the parts that would write a version into a project are off.
   */
  function centralPackageManagementBanner() {
    const cpm = state.solution.centralPackageManagement;
    if (!cpm) return null;
    return el("div", { class: "cpm-banner" }, [
      el("span", { class: "badge deprecated", text: "Central Package Management" }),
      el("span", {
        text:
          "Versions are managed in " + cpm.propsPath + ". Install, update and uninstall are disabled here — " +
          "edit that file instead.",
      }),
    ]);
  }

  function renderTabs() {
    for (const id of Object.keys(tabButtons)) {
      tabButtons[id].classList.toggle("active", id === state.tab);
    }
    searchInput.parentElement.classList.toggle("hidden", state.tab !== "browse");
    const counts = { updates: state.updates.length, consolidate: state.consolidate.length };
    for (const id of Object.keys(counts)) {
      const badge = browseBadgeEls[id];
      if (!badge) continue;
      badge.textContent = String(counts[id]);
      badge.classList.toggle("hidden", counts[id] === 0);
    }
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab === "updates") {
      post({ type: "getUpdates" });
    }
    renderTabs();
    renderList();
  }

  // ---- refresh ----
  // Manual re-sync: the panel re-reads every project from disk (packages may have changed via the
  // terminal or a hand-edited .csproj) and re-queries nuget.org for updates. Ends on the resulting
  // `solutionState` / `updates` / `error` message.
  function refreshAll() {
    if (isBusy() || state.refreshing) return;
    setRefreshing(true);
    post({ type: "refresh" });
    if (state.selectedId) requestDetails(state.selectedId, state.selectedVersion);
  }

  function setRefreshing(on) {
    state.refreshing = on;
    if (!refreshBtn) return;
    refreshBtn.classList.toggle("spinning", on);
    if (on) refreshBtn.setAttribute("disabled", "true");
    else refreshBtn.removeAttribute("disabled");
  }

  // ---- search ----
  let searchTimer;
  function onSearchInput(e) {
    state.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  }
  function onPrereleaseToggle(e) {
    state.prerelease = e.target.checked;
    if (state.query.trim()) runSearch();
    if (state.selectedId) requestDetails(state.selectedId, state.selectedVersion);
  }
  function runSearch() {
    const query = state.query.trim();
    if (!query) {
      state.results = [];
      renderList();
      return;
    }
    listEl.textContent = "";
    listEl.appendChild(el("div", { class: "loading", text: "Searching…" }));
    post({ type: "search", query, prerelease: state.prerelease, requestId: ++state.searchRequestId });
  }

  // ---- list rendering ----
  function renderList() {
    listEl.textContent = "";
    if (state.tab === "browse") return renderBrowseList();
    if (state.tab === "installed") return renderInstalledList();
    if (state.tab === "consolidate") return renderConsolidateList();
    return renderUpdatesList();
  }

  function selectableRow(id, version, iconUrl, titleChildren, subText, extra) {
    const row = el("div", { class: "row" + (state.selectedId === id ? " selected" : "") }, [
      icon(iconUrl),
      el("div", { class: "meta" }, [
        el("div", { class: "title" }, titleChildren),
        subText ? el("div", { class: "sub", text: subText }) : null,
        extra || null,
      ]),
    ]);
    row.addEventListener("click", () => selectPackage(id, version));
    return row;
  }

  function renderBrowseList() {
    if (!state.results.length) {
      listEl.appendChild(el("div", { class: "empty", text: state.query ? "No packages found." : "Type to search nuget.org." }));
      return;
    }
    for (const pkg of state.results) {
      const title = [pkg.id];
      if (pkg.verified) title.push(el("span", { class: "verified", title: "Verified", text: "✓" }));
      const warning = vulnerabilityBadge(pkg.vulnerabilities);
      listEl.appendChild(
        selectableRow(
          pkg.id,
          pkg.version,
          pkg.iconUrl,
          title,
          [formatDownloads(pkg.totalDownloads), pkg.description].filter(Boolean).join(" · "),
          warning ? el("div", { class: "badges" }, [warning]) : null,
        ),
      );
    }
  }

  function renderInstalledList() {
    if (!state.installed.length) {
      listEl.appendChild(el("div", { class: "empty", text: "No packages installed (or projects not restored yet)." }));
      return;
    }
    for (const entry of state.installed) {
      listEl.appendChild(
        selectableRow(entry.id, entry.versions[0], undefined, [entry.id], `${entry.versions.join(", ")} · ${entry.projects} project(s)`),
      );
    }
  }

  function renderUpdatesList() {
    if (!state.updates.length) {
      listEl.appendChild(el("div", { class: "empty", text: "All packages are up to date." }));
      return;
    }
    const updateAllBtn = el("button", {
      class: "action",
      onclick: updateAll,
      text: `Update all (${state.updates.length})`,
    });
    if (isBusy() || isCentrallyManaged()) updateAllBtn.setAttribute("disabled", "true");
    listEl.appendChild(el("div", { class: "list-header" }, [el("span", { text: "Available updates" }), updateAllBtn]));

    for (const upd of state.updates) {
      const updateBtn = el("button", {
        class: "action small",
        text: "Update",
        onclick: (e) => {
          e.stopPropagation();
          updateOne(upd);
        },
      });
      if (isBusy() || isCentrallyManaged()) updateBtn.setAttribute("disabled", "true");
      const extra = el("div", { class: "row-foot" }, [
        el("span", { class: "tag outdated", text: `${upd.installed} → ${upd.latest}` }),
        updateBtn,
      ]);
      listEl.appendChild(selectableRow(upd.id, upd.latest, undefined, [upd.id], undefined, extra));
    }
  }

  /**
   * Packages that sit at more than one version across the solution, with a picker for the version to
   * settle on. Unlike an update this may move a project *down* — consolidating onto an older version
   * is a legitimate choice — so the target set is resolved host-side by "not already on it".
   */
  function renderConsolidateList() {
    if (!state.consolidate.length) {
      listEl.appendChild(
        el("div", { class: "empty", text: "All packages use a consistent version across projects." }),
      );
      return;
    }
    listEl.appendChild(el("div", { class: "list-header" }, [el("span", { text: "Version conflicts" })]));

    for (const entry of state.consolidate) {
      const picker = el(
        "select",
        { class: "version-picker", onclick: (e) => e.stopPropagation() },
        entry.versions.map((v) =>
          el("option", { value: v.version, text: `${v.version} (${v.projects.length} project(s))` }),
        ),
      );
      const consolidateBtn = el("button", {
        class: "action small",
        text: "Consolidate",
        onclick: (e) => {
          e.stopPropagation();
          consolidateOne(entry.id, picker.value);
        },
      });
      if (isBusy() || isCentrallyManaged()) consolidateBtn.setAttribute("disabled", "true");

      const projectCount = entry.versions.reduce((sum, v) => sum + v.projects.length, 0);
      const extra = el("div", { class: "row-foot" }, [
        el("span", { class: "tag outdated", text: `${entry.versions.length} versions` }),
        picker,
        consolidateBtn,
      ]);
      listEl.appendChild(
        selectableRow(entry.id, entry.versions[0].version, undefined, [entry.id], `${projectCount} project(s)`, extra),
      );
    }
  }

  function consolidateOne(id, version) {
    if (isBusy() || isCentrallyManaged()) return;
    beginBusy("update", `Consolidating ${id} on ${version}…`);
    post({ type: "consolidate", id, version });
  }

  // Which projects an update moves is resolved host-side against freshly-read state; the webview only
  // names the package and the target version.
  function updateAll() {
    if (isBusy() || isCentrallyManaged()) return;
    beginBusy("update", `Updating ${state.updates.length} package(s)…`);
    post({ type: "applyUpdates", entries: state.updates.map((u) => ({ id: u.id, version: u.latest })) });
  }

  function updateOne(upd) {
    if (isBusy() || isCentrallyManaged()) return;
    beginBusy("update", `Updating ${upd.id}…`);
    post({ type: "applyUpdates", entries: [{ id: upd.id, version: upd.latest }] });
  }

  // ---- details ----
  function selectPackage(id, version) {
    state.selectedId = id;
    state.selectedVersion = version || null;
    renderList();
    requestDetails(id, version);
  }

  function requestDetails(id, version) {
    state.loadingDetails = true;
    state.details = null;
    renderDetail();
    post({ type: "getDetails", id, version: version || undefined, requestId: ++state.detailsRequestId });
  }

  function checkedProjects() {
    return state.solution.projects.filter((p) => state.checked.has(p.fsPath));
  }

  function renderDetail() {
    detailEl.textContent = "";
    if (!state.selectedId) {
      detailEl.appendChild(el("div", { class: "empty", text: "Select a package to see details." }));
      return;
    }
    const meta = state.details && state.details.metadata;
    const id = (meta && meta.id) || state.selectedId;

    // Header
    detailEl.appendChild(
      el("div", { class: "detail-head" }, [
        icon(meta && meta.iconUrl, "icon"),
        el("div", {}, [
          el("h1", { text: id }),
          el("div", { class: "authors", text: meta && meta.authors ? "by " + meta.authors : "" }),
          el("div", { text: (meta && (meta.description || meta.summary)) || "" }),
        ]),
      ]),
    );

    // Warnings for the selected version — deliberately above the actions, so they are read before
    // the Install button rather than after it.
    const warnings = [deprecationBadge(meta && meta.deprecation), vulnerabilityBadge(meta && meta.vulnerabilities)]
      .filter(Boolean);
    if (warnings.length) {
      const box = el("div", { class: "warnings" }, warnings);
      if (meta.deprecation && meta.deprecation.message) {
        box.appendChild(el("div", { class: "warning-message", text: meta.deprecation.message }));
      }
      detailEl.appendChild(box);
    }

    // Version + actions
    const versions = (state.details && state.details.versions) || (state.selectedVersion ? [state.selectedVersion] : []);
    const versionSelect = el("select", { onchange: (e) => onVersionChange(e.target.value) });
    for (const v of versions) {
      const opt = el("option", { value: v, text: v });
      if (v === currentVersion()) opt.setAttribute("selected", "true");
      versionSelect.appendChild(opt);
    }
    const anyChecked = checkedProjects().length > 0;
    const installBtn = el("button", {
      class: "action",
      onclick: () => apply("install", currentVersion()),
    }, ["Install / Update"]);
    const uninstallBtn = el("button", {
      class: "action secondary",
      onclick: () => apply("uninstall"),
    }, ["Uninstall"]);
    if (!anyChecked || isBusy() || isCentrallyManaged()) {
      installBtn.setAttribute("disabled", "true");
      uninstallBtn.setAttribute("disabled", "true");
    }
    if (isCentrallyManaged()) {
      const reason = "Disabled: this solution uses Central Package Management.";
      installBtn.setAttribute("title", reason);
      uninstallBtn.setAttribute("title", reason);
    }
    detailEl.appendChild(el("div", { class: "controls" }, [el("span", { text: "Version:" }), versionSelect, installBtn, uninstallBtn]));

    // Links
    const links = [];
    if (meta && meta.projectUrl) links.push(link("Project", meta.projectUrl));
    if (meta && (meta.licenseExpression || meta.licenseUrl)) {
      links.push(meta.licenseUrl ? link(meta.licenseExpression || "License", meta.licenseUrl) : el("span", { text: "License: " + meta.licenseExpression }));
    }
    links.push(link("nuget.org", "https://www.nuget.org/packages/" + encodeURIComponent(id)));
    detailEl.appendChild(el("div", { class: "links" }, links));

    // Project checklist
    detailEl.appendChild(renderProjects(id));

    // Dependencies
    if (meta && meta.dependencyGroups && meta.dependencyGroups.length) {
      detailEl.appendChild(renderDeps(meta.dependencyGroups));
    }

    // README
    if (state.loadingDetails) {
      detailEl.appendChild(el("div", { class: "loading", text: "Loading details…" }));
    } else if (state.details && state.details.readmeHtml) {
      const readme = el("div", { class: "readme" });
      readme.innerHTML = state.details.readmeHtml; // sanitized subset produced by the extension
      detailEl.appendChild(readme);
    }
  }

  function currentVersion() {
    if (state.selectedVersion) return state.selectedVersion;
    const versions = state.details && state.details.versions;
    return versions && versions.length ? versions[0] : undefined;
  }

  function onVersionChange(v) {
    state.selectedVersion = v;
    requestDetails(state.selectedId, v);
  }

  function link(label, url) {
    return el("a", { text: label, onclick: () => post({ type: "openExternal", url }) });
  }

  function renderProjects(id) {
    const allChecked = state.solution.projects.length > 0 && checkedProjects().length === state.solution.projects.length;
    const toggleAll = el("button", {
      class: "linkbtn",
      text: allChecked ? "Clear all" : "Select all",
      onclick: () => {
        if (allChecked) state.checked.clear();
        else state.solution.projects.forEach((p) => state.checked.add(p.fsPath));
        renderDetail();
      },
    });
    const rows = state.solution.projects.map((project) => {
      const version = installedVersionInProject(project, id);
      const cb = el("input", {
        type: "checkbox",
        onchange: (e) => {
          if (e.target.checked) state.checked.add(project.fsPath);
          else state.checked.delete(project.fsPath);
          renderDetail();
        },
      });
      if (state.checked.has(project.fsPath)) cb.setAttribute("checked", "true");
      return el("div", { class: "project" }, [
        el("label", {}, [cb, el("span", { class: "name", text: project.name })]),
        el("span", { class: "installed", text: version ? "v" + version : "—" }),
      ]);
    });
    return el("div", { class: "projects" }, [
      el("header", {}, [el("span", { text: "Projects" }), toggleAll]),
      el("div", { class: "plist" }, rows),
    ]);
  }

  function renderDeps(groups) {
    const children = groups.map((g) =>
      el("div", { class: "group" }, [
        el("span", { class: "fw", text: g.targetFramework || "All frameworks" }),
        g.dependencies.length
          ? el("div", {}, g.dependencies.map((d) => el("div", { text: `${d.id} ${d.range}` })))
          : el("div", { text: "No dependencies" }),
      ]),
    );
    return el("div", { class: "deps" }, [el("div", { class: "fw", text: "Dependencies" }), ...children]);
  }

  // ---- apply ----
  function apply(op, version) {
    if (isBusy()) return;
    let projects = checkedProjects();
    if (op === "uninstall") {
      // Pre-filtered for the message and the button state; the host filters again against fresh state.
      projects = projects.filter((p) => installedVersionInProject(p, state.selectedId));
    }
    if (!projects.length) {
      toast(op === "uninstall" ? "None of the selected projects have this package." : "Select at least one project.", true);
      return;
    }
    beginBusy(op, `${op === "uninstall" ? "Removing" : "Installing"} ${state.selectedId} in ${projects.length} project(s)…`);
    post({
      type: "apply",
      op,
      id: state.selectedId,
      version,
      projectFsPaths: projects.map((p) => p.fsPath),
    });
  }

  // ---- toast ----
  let toastEl;
  function toast(message, isError) {
    if (toastEl) toastEl.remove();
    toastEl = el("div", { class: "toast" + (isError ? " error" : ""), text: message });
    document.body.appendChild(toastEl);
    setTimeout(() => {
      if (toastEl) {
        toastEl.remove();
        toastEl = null;
      }
    }, isError ? 6000 : 3500);
  }

  // ---- progress (busy state) ----
  // A sticky bottom-right toast with a determinate bar, shown for the whole duration of an operation
  // (unlike `toast`, it does not auto-dismiss). Buttons are disabled while `state.busy` is set.
  let progressEl, progressFill, progressText;
  function beginBusy(op, label) {
    state.busy = { op };
    if (progressEl) progressEl.remove();
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
    progressFill = el("div", { class: "fill" });
    progressText = el("div", { class: "ptext", text: label });
    progressEl = el("div", { class: "toast progress" }, [progressText, el("div", { class: "bar" }, [progressFill])]);
    document.body.appendChild(progressEl);
    if (refreshBtn) refreshBtn.setAttribute("disabled", "true");
    refreshControls();
  }
  function updateProgress(done, total, id) {
    if (!progressEl) return;
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = pct + "%";
    progressText.textContent = `${id} (${done}/${total})`;
  }
  function endBusy() {
    state.busy = null;
    if (refreshBtn && !state.refreshing) refreshBtn.removeAttribute("disabled");
    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }
  }
  /** Re-render the visible list and detail so button disabled-states track `state.busy`. */
  function refreshControls() {
    renderList();
    if (state.selectedId) renderDetail();
  }

  // ---- messages from extension ----
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "solutionState":
        // VS Code hands this back to the extension when it restores the panel after a window
        // reload, which is the only way the restored instance learns which solution it managed.
        if (msg.solutionFsPath) {
          vscode.setState({ solutionFsPath: msg.solutionFsPath, preselectFsPath: msg.preselectFsPath });
        }
        applySolutionState(msg, msg.preselectFsPath);
        break;
      case "searchResults":
        if (msg.requestId === state.searchRequestId) {
          state.results = msg.results || [];
          if (state.tab === "browse") renderList();
        }
        break;
      case "details":
        if (msg.requestId === state.detailsRequestId) {
          state.loadingDetails = false;
          state.details = { metadata: msg.metadata, versions: msg.versions || [], readmeHtml: msg.readmeHtml };
          renderDetail();
        }
        break;
      case "updates":
        setRefreshing(false);
        state.updates = msg.updates || [];
        renderTabs();
        if (state.tab === "updates") renderList();
        break;
      case "applyProgress":
        updateProgress(msg.done, msg.total, msg.id);
        break;
      case "applyResult":
        onApplyResult(msg);
        break;
      case "batchResult":
        onBatchResult(msg);
        break;
      case "error":
        endBusy();
        setRefreshing(false);
        toast(msg.message || "Something went wrong.", true);
        break;
    }
  });

  /**
   * Adopts a `state` message. The solution state and the lists the extension derived from it always
   * travel together, so they are applied together and can never disagree.
   */
  function applySolutionState(msg, preselectFsPath) {
    const first = state.solution.projects.length === 0;
    state.solution = msg.state || { solutionName: "", projects: [] };
    state.installed = msg.installed || [];
    state.consolidate = msg.consolidate || [];
    if (first) {
      // Default selection: the invoking project only, else every project.
      const preselect = preselectFsPath && state.solution.projects.find((p) => p.fsPath === preselectFsPath);
      if (preselect) state.checked = new Set([preselect.fsPath]);
      else state.solution.projects.forEach((p) => state.checked.add(p.fsPath));
      buildShell();
      setTab("browse");
    } else {
      // Keep checks that still exist after a refresh.
      const existing = new Set(state.solution.projects.map((p) => p.fsPath));
      state.checked = new Set([...state.checked].filter((fs) => existing.has(fs)));
      const nameEl = document.querySelector(".solution-name");
      if (nameEl) nameEl.textContent = "Solution: " + state.solution.solutionName;
      renderTabs();
      renderList();
      if (state.selectedId) renderDetail();
    }
  }

  function onApplyResult(msg) {
    endBusy();
    if (msg.state) applySolutionState(msg, undefined);
    const failed = (msg.results || []).filter((r) => !r.ok);
    if (failed.length) {
      toast(`${msg.id}: failed in ${failed.map((r) => r.project).join(", ")} — ${failed[0].error}`, true);
    } else {
      const verb = msg.op === "uninstall" ? "Removed" : "Updated";
      toast(`${verb} ${msg.id} in ${(msg.results || []).length} project(s).`);
    }
    // Refresh the updates list in the background so the badge stays accurate.
    post({ type: "getUpdates" });
    renderList();
    if (state.selectedId) renderDetail();
  }

  function onBatchResult(msg) {
    endBusy();
    if (msg.state) applySolutionState(msg, undefined);
    const entries = msg.entries || [];
    const failedEntries = entries.filter((e) => (e.results || []).some((r) => !r.ok));
    if (msg.message) {
      // The host resolved the batch to nothing (e.g. every project already on the target version).
      toast(msg.message);
    } else if (failedEntries.length) {
      const first = failedEntries[0].results.find((r) => !r.ok);
      toast(`${failedEntries.length} of ${entries.length} update(s) failed (e.g. ${failedEntries[0].id}: ${first && first.error}).`, true);
    } else {
      toast(`Updated ${entries.length} package(s).`);
    }
    post({ type: "getUpdates" });
    renderList();
    if (state.selectedId) renderDetail();
  }

  // README links are real anchors (the renderer only ever emits http(s) hrefs), and following one
  // inside a webview would navigate the panel away from the app with no way back. Send them to the
  // host instead. One delegated listener rather than one per render: `.readme` is rebuilt on every
  // renderDetail, and this also covers any future innerHTML surface.
  document.addEventListener("click", (e) => {
    const anchor = e.target && e.target.closest && e.target.closest(".readme a[href]");
    if (!anchor) return;
    e.preventDefault();
    post({ type: "openExternal", url: anchor.getAttribute("href") });
  });

  // Kick things off.
  post({ type: "ready" });
})();

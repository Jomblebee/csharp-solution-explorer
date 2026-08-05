// @ts-check
// The Test Run Dashboard's renderer. Plain script, `window.CseDom` for the host bridge — same shell
// as the Options and Project Properties panels.
//
// Two rules shape this file:
//   1. Nothing is ever re-rendered wholesale. Rows are built once and mutated afterwards, because a
//      run can push thousands of them and rebuilding the list on every update would drop frames.
//   2. Clocks tick locally. The host sends its own `serverNow` with each update; from that we derive
//      an offset once and run a single 1s interval for the elapsed time and the ETA countdown, so no
//      message is ever sent just to move a number.

(function () {
  "use strict";

  // @ts-ignore — the namespace is the module boundary between these plain scripts.
  const { el, post, byId, toast } = window.CseDom;

  /** Finished rows kept in the DOM. Beyond this the oldest go; the counts stay exact regardless. */
  const ACTIVITY_CAP = 300;

  /** @type {any} */
  let latest;
  /** Difference between this webview's clock and the host's, in ms. */
  let clockOffset = 0;
  /** When the last update was received, on the local clock. */
  let receivedAt = 0;
  let runId = 0;
  let historical = false;
  /** @type {any} */
  let ticker;
  let filter = "all";

  /** @type {Map<string, {row: HTMLElement, bar: HTMLElement, phase: HTMLElement, line: HTMLElement}>} */
  const projectRows = new Map();

  build();
  post({ type: "ready" });

  // ---- Shell -------------------------------------------------------------------------------

  function build() {
    const app = byId("app");
    if (!app) {
      return;
    }
    app.removeAttribute("aria-busy");
    app.appendChild(
      el("div", { class: "panel-toolbar" }, [
        el("h1", { class: "panel-title", text: "Test Run" }),
        el("span", { id: "statusBadge", class: "badge", text: "Idle" }),
        el("span", { id: "runTitle", class: "panel-subtitle" }),
        el("div", { class: "panel-spacer" }),
        button("btnCancel", "Cancel run", () => post({ type: "cancelRun" })),
        button("btnRerunFailed", "Re-run failed", () => post({ type: "rerunFailed" }), true),
        button("btnRerunAll", "Re-run all", () => post({ type: "rerunAll" }), true),
        button("btnOutput", "Output", () => post({ type: "openOutput" }), true),
      ]),
    );

    app.appendChild(
      el("div", { class: "run-hero" }, [
        el(
          "div",
          {
            id: "bar",
            class: "progress",
            role: "progressbar",
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            "aria-valuenow": "0",
          },
          [
            el("div", { id: "segPassed", class: "progress-seg passed" }),
            el("div", { id: "segFailed", class: "progress-seg failed" }),
            el("div", { id: "segSkipped", class: "progress-seg skipped" }),
            el("div", { class: "progress-rest" }),
          ],
        ),
        el("div", { class: "run-stats" }, [
          stat("statPassed", "Passed", "passed"),
          stat("statFailed", "Failed", "failed"),
          stat("statSkipped", "Skipped", "skipped"),
          stat("statTotal", "Total"),
          stat("statElapsed", "Elapsed"),
        ]),
        el("div", { class: "run-eta" }, [
          el("span", { id: "etaText", text: "estimating…" }),
          el("span", { id: "etaHint", class: "run-eta-hint" }),
        ]),
      ]),
    );

    app.appendChild(
      el("div", { class: "panel-body" }, [
        el("div", { class: "panel-content" }, [
          el("div", { class: "panel-content-inner" }, [
            card("Projects", [el("div", { id: "projectList" }), el("div", { id: "projectNote", class: "note hidden" })]),
            card("Failures", [el("div", { id: "failureList" }), el("div", { id: "failureEmpty", class: "note", text: "No failures." })], "failureCount"),
            card("Slowest tests", [el("div", { id: "slowList" }), el("div", { id: "slowEmpty", class: "note", text: "No timings yet." })]),
            card("Activity", [
              el("div", { class: "tabs" }, [
                tab("all", "All"),
                tab("running", "Running"),
                tab("failed", "Failed"),
                tab("skipped", "Skipped"),
              ]),
              el("div", { id: "runningList" }),
              el("div", { id: "activityList", class: "activity-list" }),
              el("div", { id: "activityNote", class: "note hidden" }),
            ]),
          ]),
        ]),
      ]),
    );
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {() => void} onclick
   * @param {boolean} [secondary]
   */
  function button(id, label, onclick, secondary) {
    return el("button", { id, class: secondary ? "action secondary" : "action", text: label, onclick });
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {string} [kind]
   */
  function stat(id, label, kind) {
    return el("div", { class: kind ? `stat ${kind}` : "stat" }, [
      el("div", { id, class: "stat-value", text: "0" }),
      el("div", { class: "stat-label", text: label }),
    ]);
  }

  /**
   * @param {string} title
   * @param {Array<HTMLElement>} body
   * @param {string} [countId]
   */
  function card(title, body, countId) {
    return el("section", { class: "card" }, [
      el("div", { class: "card-header" }, [
        el("h2", { class: "card-title", text: title }),
        countId ? el("span", { id: countId, class: "card-count" }) : null,
      ]),
      el("div", { class: "card-body" }, body),
    ]);
  }

  /**
   * @param {string} value
   * @param {string} label
   */
  function tab(value, label) {
    return el("button", {
      class: value === "all" ? "tab active" : "tab",
      "data-filter": value,
      text: label,
      onclick: (/** @type {Event} */ event) => {
        filter = value;
        const target = event.currentTarget;
        if (target instanceof HTMLElement && target.parentElement) {
          for (const other of Array.from(target.parentElement.children)) {
            other.classList.toggle("active", other === target);
          }
        }
        applyFilter();
      },
    });
  }

  // ---- Host messages -----------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "update":
        historical = false;
        apply(message);
        break;
      case "idle":
        historical = true;
        if (message.last) {
          apply(message.last, message.lastEndedAt);
        } else {
          showEmpty();
        }
        break;
      case "error":
        toast(message.message, true);
        break;
    }
  });

  /**
   * @param {any} update
   * @param {number} [endedAt]
   */
  function apply(update, endedAt) {
    if (update.header.runId !== runId) {
      runId = update.header.runId;
      resetLists();
    }
    latest = update;
    clockOffset = Date.now() - update.serverNow;
    receivedAt = Date.now();

    setText("runTitle", historical ? `Last run — ${ago(endedAt || update.endedAt)}` : update.header.title);
    setBadge(update.state);
    renderCounts(update);
    renderProjects(update);
    renderRunning(update);
    renderFinished(update);
    renderFailures(update);
    renderSlowest(update);
    renderButtons(update);
    applyFilter();
    tick();
    if (update.state === "running" && !historical) {
      startTicker();
    } else {
      stopTicker();
    }
  }

  function showEmpty() {
    setText("runTitle", "No test run yet");
    setBadge("idle");
    renderButtons({ state: "idle", failed: 0, errored: 0 });
    stopTicker();
  }

  // ---- Rendering ---------------------------------------------------------------------------

  /** @param {any} update */
  function renderCounts(update) {
    const total = update.total || 0;
    setText("statPassed", String(update.passed));
    setText("statFailed", String(update.failed + update.errored));
    setText("statSkipped", String(update.skipped));
    setText("statTotal", update.totalIsLowerBound ? `≥ ${total}` : String(total));

    const bar = byId("bar");
    if (!bar) {
      return;
    }
    // No total means no fraction: an animated stripe is honest, a percentage would not be.
    const indeterminate = !total;
    bar.classList.toggle("indeterminate", indeterminate);
    bar.classList.toggle("lower-bound", !indeterminate && update.totalIsLowerBound);
    bar.title = update.totalIsLowerBound
      ? "At least this many tests — a project could not report its count before running."
      : "";
    width("segPassed", indeterminate ? 0 : (update.passed / total) * 100);
    width("segFailed", indeterminate ? 0 : ((update.failed + update.errored) / total) * 100);
    width("segSkipped", indeterminate ? 0 : (update.skipped / total) * 100);
    bar.setAttribute("aria-valuenow", String(Math.round((update.eta.fraction || 0) * 100)));
  }

  /** @param {any} update */
  function renderProjects(update) {
    const list = byId("projectList");
    if (!list) {
      return;
    }
    let anyBatched = false;
    for (const project of update.projects) {
      anyBatched = anyBatched || !project.liveResults;
      let entry = projectRows.get(project.id);
      if (!entry) {
        const bar = el("span");
        const phase = el("span", { class: "row-detail" });
        const line = el("span", { class: "row-detail" });
        const row = el("div", { class: "project-row" }, [
          el("span", { class: "row-name", text: project.name }),
          el("span", { class: "badge", text: project.liveResults ? "MTP" : "VSTest" }),
          el("span", { class: "mini-bar" }, [bar]),
          phase,
          line,
        ]);
        entry = { row, bar, phase, line };
        projectRows.set(project.id, entry);
        list.appendChild(row);
      }
      const known = project.known;
      const mini = entry.bar.parentElement;
      if (mini) {
        mini.classList.toggle("indeterminate", project.phase !== "finished" && !known);
      }
      entry.bar.style.width = known ? `${Math.min(100, (project.completed / known) * 100)}%` : "0";
      entry.phase.textContent = phaseText(project);
      entry.line.textContent = project.error || project.lastLine || "";
    }
    toggle("projectNote", !anyBatched);
    setText(
      "projectNote",
      "VSTest projects report every result at once when the run finishes. Projects on Microsoft.Testing.Platform stream results live.",
    );
  }

  /** @param {any} project */
  function phaseText(project) {
    if (project.phase === "finished") {
      return `${project.passed} passed, ${project.failed + project.errored} failed, ${project.skipped} skipped`;
    }
    if (project.phase === "discovering") {
      return "Discovering tests…";
    }
    if (project.phase === "building") {
      return "Building…";
    }
    if (project.phase === "pending") {
      return "Queued";
    }
    return project.liveResults
      ? `Running — ${project.completed}${project.known ? ` of ${project.known}` : ""}`
      : "Running — results arrive at the end";
  }

  /** @param {any} update */
  function renderRunning(update) {
    const list = byId("runningList");
    if (!list) {
      return;
    }
    list.textContent = "";
    for (const row of update.running) {
      list.appendChild(
        el("div", { class: "test-row", "data-kind": "running" }, [
          el("span", { class: "mark running" }),
          el("span", { class: "row-name", text: row.name }),
          el("span", { class: "row-class", text: "running…" }),
        ]),
      );
    }
  }

  /** @param {any} update */
  function renderFinished(update) {
    const list = byId("activityList");
    if (!list) {
      return;
    }
    if (update.full) {
      list.textContent = "";
    }
    // Newest first: prepending in reverse keeps the incoming batch in order at the top.
    for (let i = update.finished.length - 1; i >= 0; i--) {
      list.insertBefore(finishedRow(update.finished[i]), list.firstChild);
    }
    while (list.childElementCount > ACTIVITY_CAP) {
      const last = list.lastElementChild;
      if (!last) {
        break;
      }
      list.removeChild(last);
    }
    const dropped = update.finishedDropped || 0;
    toggle("activityNote", dropped === 0);
    setText("activityNote", dropped > 0 ? `+${dropped} more results not listed.` : "");
  }

  /** @param {any} row */
  function finishedRow(row) {
    return el(
      "div",
      { class: "test-row", "data-kind": row.outcome, title: row.message || "" },
      [
        el("span", { class: `mark ${row.outcome}` }),
        el("span", { class: "row-name", text: row.name }),
        el("span", { class: "row-class", text: row.className }),
        el("span", { class: "row-duration", text: row.durationMs == null ? "" : formatDuration(row.durationMs) }),
      ],
    );
  }

  /** @param {any} update */
  function renderFailures(update) {
    const list = byId("failureList");
    if (!list) {
      return;
    }
    list.textContent = "";
    for (const row of update.failures) {
      list.appendChild(
        el("div", { class: "test-row" }, [
          el("span", { class: `mark ${row.outcome}` }),
          el("span", { class: "row-name", text: `${row.className}.${row.name}` }),
          el("span", { class: "row-detail", text: firstLine(row.message) }),
          row.hasSource
            ? el("button", { class: "action ghost", text: "Open", onclick: () => post({ type: "openTest", id: row.id }) })
            : null,
        ]),
      );
    }
    setText("failureCount", update.failuresTruncated ? `${update.failures.length}+` : String(update.failures.length));
    toggle("failureEmpty", update.failures.length > 0);
  }

  /** @param {any} update */
  function renderSlowest(update) {
    const list = byId("slowList");
    if (!list) {
      return;
    }
    list.textContent = "";
    for (const row of update.slowest) {
      list.appendChild(
        el("div", { class: "test-row" }, [
          el("span", { class: `mark ${row.outcome}` }),
          el("span", { class: "row-name", text: row.name }),
          el("span", { class: "row-class", text: row.className }),
          el("span", { class: "row-duration", text: formatDuration(row.durationMs || 0) }),
          deltaCell(row.deltaMs),
        ]),
      );
    }
    toggle("slowEmpty", update.slowest.length > 0);
  }

  /** @param {number | undefined} delta */
  function deltaCell(delta) {
    if (delta == null || Math.abs(delta) < 1) {
      return el("span", { class: "row-duration" });
    }
    const slower = delta > 0;
    return el("span", {
      class: `row-duration row-delta ${slower ? "slower" : "faster"}`,
      text: `${slower ? "+" : "−"}${formatDuration(Math.abs(delta))}`,
      title: "Change against this test's previous run.",
    });
  }

  /** @param {any} update */
  function renderButtons(update) {
    const running = update.state === "running" && !historical;
    disable("btnCancel", !running);
    disable("btnRerunFailed", running || (update.failed || 0) + (update.errored || 0) === 0);
    disable("btnRerunAll", running);
  }

  function applyFilter() {
    const running = byId("runningList");
    if (running) {
      running.classList.toggle("hidden", filter !== "all" && filter !== "running");
    }
    const list = byId("activityList");
    if (!list) {
      return;
    }
    for (const child of Array.from(list.children)) {
      const kind = child.getAttribute("data-kind") || "";
      const visible =
        filter === "all" ||
        (filter === "failed" && (kind === "failed" || kind === "errored")) ||
        (filter === "skipped" && kind === "skipped");
      child.classList.toggle("hidden", !visible);
    }
  }

  // ---- Local clock -------------------------------------------------------------------------

  function startTicker() {
    if (!ticker) {
      ticker = setInterval(tick, 1000);
    }
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function tick() {
    if (!latest) {
      return;
    }
    const live = latest.state === "running" && !historical;
    const hostNow = live ? Date.now() - clockOffset : latest.endedAt || latest.serverNow;
    setText("statElapsed", formatDuration(Math.max(0, hostNow - latest.header.startedAt)));

    if (!live) {
      setText("etaText", latest.state === "cancelled" ? "Run cancelled" : "Run finished");
      setText("etaHint", "");
      return;
    }
    if (latest.eta.remainingMs == null) {
      setText("etaText", "estimating…");
      setText("etaHint", latest.totalIsLowerBound ? "waiting for a project to report its test count" : "");
      return;
    }
    // Decay the host's estimate locally so the number moves every second instead of every push.
    const remaining = Math.max(0, latest.eta.remainingMs - (Date.now() - receivedAt));
    setText("etaText", remaining < 1000 ? "almost done" : `${prefix(latest.eta.basis)} ${formatDuration(remaining)} remaining`);
    setText("etaHint", latest.eta.basis === "rate" ? "estimated from this run's pace" : "estimated from previous runs");
  }

  /** @param {string} basis */
  function prefix(basis) {
    return basis === "durations" ? "about" : "roughly";
  }

  // ---- Helpers -----------------------------------------------------------------------------

  function resetLists() {
    projectRows.clear();
    for (const id of ["projectList", "activityList", "runningList", "failureList", "slowList"]) {
      const node = byId(id);
      if (node) {
        node.textContent = "";
      }
    }
  }

  /** @param {string} state */
  function setBadge(state) {
    const badge = byId("statusBadge");
    if (!badge) {
      return;
    }
    const labels = { running: "Running", passed: "Passed", failed: "Failed", cancelled: "Cancelled", idle: "Idle" };
    badge.textContent = labels[state] || state;
    badge.className = state === "failed" ? "badge warn" : "badge";
    badge.setAttribute("aria-live", "polite");
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  function setText(id, text) {
    const node = byId(id);
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  /**
   * @param {string} id
   * @param {number} percent
   */
  function width(id, percent) {
    const node = byId(id);
    if (node) {
      node.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
  }

  /**
   * @param {string} id
   * @param {boolean} hidden
   */
  function toggle(id, hidden) {
    const node = byId(id);
    if (node) {
      node.classList.toggle("hidden", hidden);
    }
  }

  /**
   * @param {string} id
   * @param {boolean} disabled
   */
  function disable(id, disabled) {
    const node = byId(id);
    if (node instanceof HTMLButtonElement) {
      node.disabled = disabled;
    }
  }

  /** @param {string | undefined} message */
  function firstLine(message) {
    if (!message) {
      return "";
    }
    const line = message.split("\n")[0].trim();
    return line.length > 160 ? `${line.slice(0, 160)}…` : line;
  }

  /** Mirrors formatDuration in src/testExplorer/dashboard/testRunEta.ts. */
  function formatDuration(ms) {
    const safe = Math.max(0, Math.round(ms));
    if (safe === 0) {
      return "0s";
    }
    if (safe < 10000) {
      return `${(Math.floor(safe / 100) / 10).toFixed(1)}s`;
    }
    const seconds = Math.floor(safe / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ${pad(seconds % 60)}s`;
    }
    return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
  }

  /** @param {number} value */
  function pad(value) {
    return value < 10 ? `0${value}` : `${value}`;
  }

  /** @param {number | undefined} timestamp */
  function ago(timestamp) {
    if (!timestamp) {
      return "earlier";
    }
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
})();

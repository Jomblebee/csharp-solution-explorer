// @ts-check
// The left navigation: one entry per group, click-to-scroll, and a scroll-spy that highlights the
// section currently in view.

(function () {
  "use strict";

  // @ts-ignore
  const { el } = window.CseDom;

  /**
   * @param {Array<{id: string, title: string}>} groups
   * @param {(id: string) => void} onSelect
   * @returns {{ element: HTMLElement, setActive: (id: string) => void, setVisible: (ids: Set<string>) => void }}
   */
  function renderNav(groups, onSelect) {
    /** @type {Map<string, HTMLElement>} */
    const links = new Map();

    const list = el(
      "ul",
      { class: "nav-list" },
      groups.map((group) => {
        const link = el("button", {
          class: "nav-link",
          type: "button",
          text: group.title,
          onclick: () => onSelect(group.id),
        });
        links.set(group.id, link);
        return el("li", null, [link]);
      }),
    );

    const nav = el("nav", { class: "options-nav", "aria-label": "Setting groups" }, [list]);

    return {
      element: nav,
      setActive: (id) => {
        for (const [groupId, link] of links) {
          link.classList.toggle("active", groupId === id);
        }
      },
      setVisible: (ids) => {
        for (const [groupId, link] of links) {
          const item = link.parentElement;
          if (item) {
            item.classList.toggle("hidden", !ids.has(groupId));
          }
        }
      },
    };
  }

  /**
   * Highlights whichever section is nearest the top of the scroll container. An IntersectionObserver
   * alone reports "some part is visible", which flickers between neighbours on a fast scroll; the
   * observer is used only as a cheap trigger, and the decision is made from the actual positions.
   *
   * @param {HTMLElement} container
   * @param {Array<{id: string, element: HTMLElement}>} sections
   * @param {(id: string) => void} onActive
   * @returns {{ dispose: () => void }} disposing removes both the observer and the scroll listener —
   *   the sections are rebuilt on every scope switch, and a leftover listener would keep firing
   *   against the discarded ones.
   */
  function observeSections(container, sections, onActive) {
    let active = "";
    const pick = () => {
      let best = sections[0];
      for (const section of sections) {
        if (section.element.classList.contains("hidden")) {
          continue;
        }
        const top = section.element.getBoundingClientRect().top - container.getBoundingClientRect().top;
        if (top <= 24) {
          best = section;
        }
      }
      if (best && best.id !== active) {
        active = best.id;
        onActive(active);
      }
    };

    const observer = new IntersectionObserver(pick, { root: container, threshold: [0, 0.25, 1] });
    for (const section of sections) {
      observer.observe(section.element);
    }
    container.addEventListener("scroll", pick, { passive: true });
    pick();
    return {
      dispose: () => {
        observer.disconnect();
        container.removeEventListener("scroll", pick);
      },
    };
  }

  // @ts-ignore
  window.CseOptionsNav = { renderNav, observeSections };
})();

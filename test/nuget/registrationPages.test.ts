import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderPagesForVersion, pickCatalogEntry } from "../../src/nuget/registrationPages.js";

describe("orderPagesForVersion", () => {
  // Mirrors a real nuget.org index: several pages, none of them carrying inline items.
  const pages = [
    { "@id": "oldest", lower: "0.1.6", upper: "1.2.47" },
    { "@id": "middle", lower: "1.2.48", upper: "3.0.1" },
    { "@id": "newest", lower: "3.0.2", upper: "4.4.0" },
  ];

  it("puts the newest page first when no version is requested", () => {
    // Front-to-back order would land on the oldest page and report an ancient version as "latest".
    assert.deepEqual(
      orderPagesForVersion(pages).map((p) => p["@id"]),
      ["newest", "middle", "oldest"],
    );
  });

  it("puts the page whose range covers the requested version first", () => {
    assert.equal(orderPagesForVersion(pages, "2.10.0")[0]["@id"], "middle");
    assert.equal(orderPagesForVersion(pages, "0.5.0")[0]["@id"], "oldest");
    assert.equal(orderPagesForVersion(pages, "4.4.0")[0]["@id"], "newest");
  });

  it("includes the range boundaries themselves", () => {
    assert.equal(orderPagesForVersion(pages, "1.2.48")[0]["@id"], "middle");
    assert.equal(orderPagesForVersion(pages, "3.0.1")[0]["@id"], "middle");
  });

  it("keeps every page even when none covers the version, newest first", () => {
    assert.deepEqual(
      orderPagesForVersion(pages, "99.0.0").map((p) => p["@id"]),
      ["newest", "middle", "oldest"],
    );
  });

  it("does not drop pages without bounds, and does not mutate the input", () => {
    const unbounded = [{ "@id": "a" }, { "@id": "b", lower: "1.0.0", upper: "2.0.0" }];
    const original = [...unbounded];
    assert.equal(orderPagesForVersion(unbounded, "1.5.0")[0]["@id"], "b");
    assert.equal(orderPagesForVersion(unbounded).length, 2);
    assert.deepEqual(unbounded, original);
  });

  it("handles an empty index", () => {
    assert.deepEqual(orderPagesForVersion([]), []);
  });
});

describe("pickCatalogEntry", () => {
  const pages = [
    {
      items: [
        { catalogEntry: { id: "P", version: "1.0.0", listed: true } },
        { catalogEntry: { id: "P", version: "2.0.0", listed: true } },
        { catalogEntry: { id: "P", version: "2.1.0-beta", listed: true } },
        { catalogEntry: { id: "P", version: "0.9.0", listed: false } },
      ],
    },
  ];

  it("returns the newest listed stable entry when no version is requested", () => {
    assert.equal(pickCatalogEntry(pages)?.version, "2.0.0");
  });

  it("returns the exact requested version, including a prerelease", () => {
    assert.equal(pickCatalogEntry(pages, "2.1.0-beta")?.version, "2.1.0-beta");
    assert.equal(pickCatalogEntry(pages, "9.9.9"), undefined);
  });
});

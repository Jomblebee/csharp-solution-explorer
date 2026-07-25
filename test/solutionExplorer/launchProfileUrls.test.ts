import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApplicationUrl,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parseApplicationUrl,
} from "../../src/solutionExplorer/launchProfileUrls.js";

describe("parseApplicationUrl", () => {
  it("reads both schemes with ports", () => {
    assert.deepEqual(parseApplicationUrl("https://localhost:7001;http://localhost:5001"), {
      scheme: "both",
      ports: { httpsPort: 7001, httpPort: 5001 },
    });
  });

  it("reads https only", () => {
    assert.deepEqual(parseApplicationUrl("https://localhost:7080"), {
      scheme: "https",
      ports: { httpsPort: 7080 },
    });
  });

  it("reads http only", () => {
    assert.deepEqual(parseApplicationUrl("http://localhost:5080"), {
      scheme: "http",
      ports: { httpPort: 5080 },
    });
  });

  it("handles a scheme without a port", () => {
    assert.deepEqual(parseApplicationUrl("https://localhost"), { scheme: "https", ports: {} });
  });

  it("defaults an empty value to both with no ports", () => {
    assert.deepEqual(parseApplicationUrl(""), { scheme: "both", ports: {} });
    assert.deepEqual(parseApplicationUrl(undefined), { scheme: "both", ports: {} });
  });

  it("ignores unrecognized entries", () => {
    assert.deepEqual(parseApplicationUrl("not-a-url;http://localhost:5005"), {
      scheme: "http",
      ports: { httpPort: 5005 },
    });
  });
});

describe("buildApplicationUrl", () => {
  it("builds both with given ports, https first", () => {
    assert.equal(
      buildApplicationUrl("both", { httpsPort: 7001, httpPort: 5001 }),
      "https://localhost:7001;http://localhost:5001",
    );
  });

  it("builds https only", () => {
    assert.equal(buildApplicationUrl("https", { httpsPort: 7080 }), "https://localhost:7080");
  });

  it("builds http only", () => {
    assert.equal(buildApplicationUrl("http", { httpPort: 5080 }), "http://localhost:5080");
  });

  it("fills in default ports when missing", () => {
    assert.equal(
      buildApplicationUrl("both", {}),
      `https://localhost:${DEFAULT_HTTPS_PORT};http://localhost:${DEFAULT_HTTP_PORT}`,
    );
  });
});

describe("parse then build round-trip", () => {
  it("preserves both scheme and ports", () => {
    const url = "https://localhost:7123;http://localhost:5123";
    const { scheme, ports } = parseApplicationUrl(url);
    assert.equal(buildApplicationUrl(scheme, ports), url);
  });
});

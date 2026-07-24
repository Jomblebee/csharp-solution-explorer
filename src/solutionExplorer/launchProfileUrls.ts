// Guided editing of a web profile's `applicationUrl`, kept pure (no vscode) so it stays unit-testable
// while the QuickPick/InputBox UI in launchProfileEditor is not. A profile's `applicationUrl` is a
// semicolon-delimited list like "https://localhost:7001;http://localhost:5001"; the editor lets the
// user pick a scheme and ports rather than hand-type that string.

export type UrlScheme = "both" | "https" | "http";

export interface UrlPorts {
  httpsPort?: number;
  httpPort?: number;
}

/** The kestrel dev-cert HTTPS / HTTP defaults `dotnet new` uses when a template picks fixed ports. */
export const DEFAULT_HTTPS_PORT = 7001;
export const DEFAULT_HTTP_PORT = 5001;

const URL_ENTRY_PATTERN = /^(https?):\/\/[^:/]+(?::(\d+))?/i;

/**
 * Reads the scheme and ports out of an `applicationUrl`. An empty/absent value is treated as "both"
 * with no ports (the editor fills in defaults). Unrecognized entries are ignored.
 */
export function parseApplicationUrl(applicationUrl?: string): { scheme: UrlScheme; ports: UrlPorts } {
  const ports: UrlPorts = {};
  let hasHttps = false;
  let hasHttp = false;

  for (const raw of (applicationUrl ?? "").split(";")) {
    const match = URL_ENTRY_PATTERN.exec(raw.trim());
    if (!match) {
      continue;
    }
    const port = match[2] ? Number(match[2]) : undefined;
    if (match[1].toLowerCase() === "https") {
      hasHttps = true;
      if (port !== undefined) {
        ports.httpsPort = port;
      }
    } else {
      hasHttp = true;
      if (port !== undefined) {
        ports.httpPort = port;
      }
    }
  }

  const scheme: UrlScheme = hasHttps && hasHttp ? "both" : hasHttp ? "http" : hasHttps ? "https" : "both";
  return { scheme, ports };
}

/**
 * Builds an `applicationUrl` for the chosen scheme, filling in the default port for any side that
 * has none. HTTPS is listed first (matching the ASP.NET templates).
 */
export function buildApplicationUrl(scheme: UrlScheme, ports: UrlPorts): string {
  const https = `https://localhost:${ports.httpsPort ?? DEFAULT_HTTPS_PORT}`;
  const http = `http://localhost:${ports.httpPort ?? DEFAULT_HTTP_PORT}`;
  switch (scheme) {
    case "https":
      return https;
    case "http":
      return http;
    default:
      return `${https};${http}`;
  }
}

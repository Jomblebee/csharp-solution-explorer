// Streaming HTTP download with VS Code progress reporting. Shared by the language server and the
// debugger downloads — both fetch a single archive over plain HTTP and want byte-level progress.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import * as vscode from "vscode";

export type Reporter = (message?: string, fraction?: number) => void;

/** Turns absolute-fraction reports into the delta `increment`s VS Code's progress API expects. */
export function makeReporter(progress: vscode.Progress<{ message?: string; increment?: number }>): Reporter {
  let lastPct = 0;
  return (message, fraction) => {
    const update: { message?: string; increment?: number } = {};
    if (message !== undefined) {
      update.message = message;
    }
    if (typeof fraction === "number") {
      const pct = Math.max(0, Math.min(100, fraction * 100));
      update.increment = Math.max(0, pct - lastPct);
      lastPct = pct;
    }
    progress.report(update);
  };
}

/** Raised when a host can't be reached at all (offline/proxy), as opposed to an HTTP error status. */
export class DownloadUnreachableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "DownloadUnreachableError";
    this.cause = cause;
  }
}

/**
 * Downloads `url` to `dest`, reporting progress from `content-length` when the server sends it.
 * `label` names the artifact in error messages (e.g. "the C# language server"). Redirects are
 * followed by `fetch` itself, which matters for GitHub release assets.
 */
export async function downloadFile(url: string, dest: string, report: Reporter, label: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/octet-stream" } });
  } catch (err) {
    throw new DownloadUnreachableError(`Could not reach the server hosting ${label}.`, err);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${label} (${res.status} ${res.statusText}).`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      report(`Downloading… ${mb(received)} / ${mb(total)} MB`, received / total);
    } else {
      report(`Downloading… ${mb(received)} MB`);
    }
  });
  await pipeline(source, fs.createWriteStream(dest));
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(0);

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// The Debug Adapter Protocol's wire format: `Content-Length: <n>\r\n\r\n<n bytes of JSON>`. Framing
// is done by hand here because we sit between VS Code and netcoredbg to rewrite messages, which
// means owning the pipe. Kept free of `vscode` and `child_process` so it can be unit-tested.

/** The length header is a *byte* count, so everything works on Buffers, never strings. */
const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH = /^Content-Length:\s*(\d+)\s*$/i;

export interface ParseResult {
  messages: unknown[];
  /** Malformed frames, reported so a protocol bug shows up in the log instead of hanging silently. */
  errors: string[];
}

/**
 * Reassembles DAP messages from a byte stream. A chunk may hold several messages, part of one, or
 * split a header mid-way, so leftovers are buffered until the next chunk completes them.
 */
export class DapMessageParser {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): ParseResult {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    const errors: string[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        break;
      }
      const length = contentLength(this.buffer.subarray(0, headerEnd).toString("ascii"));
      if (length === undefined) {
        // Unrecoverable: without a length we cannot find where this message ends. Drop the header
        // and resynchronise on the next one rather than mis-slicing the rest of the stream.
        errors.push(`Discarded a frame with no Content-Length header: ${JSON.stringify(this.buffer.subarray(0, headerEnd).toString("utf8"))}`);
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (this.buffer.length < bodyStart + length) {
        break; // Body still incomplete — wait for more bytes.
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        errors.push(`Discarded an unparseable message body: ${JSON.stringify(body)}`);
      }
    }

    return { messages, errors };
  }
}

/** Frames a message for the wire. */
export function encodeDapMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`, "ascii"), body]);
}

function contentLength(headerBlock: string): number | undefined {
  for (const line of headerBlock.split("\r\n")) {
    const match = CONTENT_LENGTH.exec(line);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

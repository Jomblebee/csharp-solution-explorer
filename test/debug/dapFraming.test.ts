import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DapMessageParser, encodeDapMessage } from "../../src/debug/dapFraming.js";

const frame = (body: string): Buffer =>
  Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, "ascii"), Buffer.from(body, "utf8")]);

describe("DapMessageParser", () => {
  it("reads a single complete message", () => {
    const { messages, errors } = new DapMessageParser().append(frame('{"seq":1,"type":"event"}'));
    assert.deepEqual(messages, [{ seq: 1, type: "event" }]);
    assert.deepEqual(errors, []);
  });

  it("reads several messages arriving in one chunk", () => {
    const chunk = Buffer.concat([frame('{"seq":1}'), frame('{"seq":2}'), frame('{"seq":3}')]);
    const { messages } = new DapMessageParser().append(chunk);
    assert.deepEqual(messages, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });

  it("buffers a message split across chunks, including mid-header", () => {
    const parser = new DapMessageParser();
    const whole = frame('{"seq":7,"command":"threads"}');
    // Split inside the header, then inside the body.
    assert.deepEqual(parser.append(whole.subarray(0, 8)).messages, []);
    assert.deepEqual(parser.append(whole.subarray(8, 25)).messages, []);
    assert.deepEqual(parser.append(whole.subarray(25)).messages, [{ seq: 7, command: "threads" }]);
  });

  it("counts the length in bytes, not characters", () => {
    // "ü" and "→" are multi-byte; a char-based length would slice the body short.
    const body = '{"name":"Grüße →"}';
    const { messages } = new DapMessageParser().append(frame(body));
    assert.deepEqual(messages, [{ name: "Grüße →" }]);
  });

  it("keeps the trailing partial message when a chunk ends mid-body", () => {
    const parser = new DapMessageParser();
    const two = Buffer.concat([frame('{"seq":1}'), frame('{"seq":2}')]);
    const cut = two.length - 4;
    assert.deepEqual(parser.append(two.subarray(0, cut)).messages, [{ seq: 1 }]);
    assert.deepEqual(parser.append(two.subarray(cut)).messages, [{ seq: 2 }]);
  });

  it("tolerates extra headers before the separator", () => {
    const body = '{"seq":1}';
    const chunk = Buffer.from(
      `Content-Type: application/vscode-jsonrpc\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      "utf8",
    );
    assert.deepEqual(new DapMessageParser().append(chunk).messages, [{ seq: 1 }]);
  });

  it("reports an unparseable body and recovers on the next message", () => {
    const parser = new DapMessageParser();
    const chunk = Buffer.concat([frame("{not json"), frame('{"seq":2}')]);
    const { messages, errors } = parser.append(chunk);
    assert.deepEqual(messages, [{ seq: 2 }]);
    assert.equal(errors.length, 1);
  });

  it("reports a frame with no Content-Length and resynchronises", () => {
    const parser = new DapMessageParser();
    const chunk = Buffer.concat([Buffer.from("Nonsense: 1\r\n\r\n", "ascii"), frame('{"seq":2}')]);
    const { messages, errors } = parser.append(chunk);
    assert.deepEqual(messages, [{ seq: 2 }]);
    assert.equal(errors.length, 1);
  });
});

describe("encodeDapMessage", () => {
  it("round-trips through the parser", () => {
    const message = { seq: 42, type: "request", command: "threads", arguments: { text: "Grüße" } };
    assert.deepEqual(new DapMessageParser().append(encodeDapMessage(message)).messages, [message]);
  });

  it("writes a byte length, not a character count", () => {
    const encoded = encodeDapMessage({ a: "ü" }).toString("utf8");
    assert.match(encoded, /^Content-Length: 10\r\n\r\n/);
  });
});

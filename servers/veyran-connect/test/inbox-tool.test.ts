/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * `capture_note` end to end, with **no network at all**: the HTTPS sender is
 * replaced by a recording fake, so every assertion is about this server's own
 * behaviour — the exact request it would send, what it reports, what it refuses,
 * and what it never claims.
 *
 * A separate suite drives the *real* MCP server through the SDK's in-memory
 * transport, so registration, the visible input schema, the strict output schema
 * and the error surface are exercised through the official path.
 *
 * Nothing here uses a real account, key, note or endpoint.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  CAPTURE_NOTE_ANNOTATIONS,
  CAPTURE_NOTE_TOOL_NAME,
  captureNoteOutputSchema,
  createCaptureNoteHandler,
  registerCaptureNote
} from "../src/inbox-tool.js";
import {
  InboxReceiptStore,
  saveInboxApiKey,
  type InboxReceipt
} from "../src/inbox-profile.js";
import type { InboxOutcome, InboxSender } from "../src/inbox-transport.js";
import { INBOX_ENDPOINT_URL } from "../src/inbox-transport.js";
import { ensureSecureDir } from "../src/secure-files.js";
import { buildMcpServer } from "../src/mcp.js";
import {
  TOOL_ERROR_MESSAGES,
  type ToolErrorCode
} from "../src/errors.js";
import type { ToolCallResult, ToolHandler, ToolRegistrar } from "../src/tools.js";
import { INBOX_LIMITS } from "../src/limits.js";

const TEST_KEY = "nn_inbox_testkey_0123456789abcdef";
const OTHER_KEY = "nn_inbox_otherkey_fedcba9876543210";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

interface FakeSender extends InboxSender {
  calls: { apiKey: string; body: string }[];
}

/** A sender whose outcomes are scripted; it records every call it receives. */
function fakeSender(
  outcomes: InboxOutcome[],
  onSend?: (body: string) => void
): FakeSender {
  const calls: { apiKey: string; body: string }[] = [];
  return {
    calls,
    async send(request) {
      calls.push({ ...request });
      onSend?.(request.body);
      const outcome = outcomes.length > 1 ? outcomes.shift()! : outcomes[0];
      if (!outcome) throw new Error("fake sender: no scripted outcome");
      return outcome;
    }
  };
}

async function tempProfile(withKey = true): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-inbox-tool-"));
  dirs.push(base);
  const profile = path.join(base, "profile");
  await ensureSecureDir(profile);
  if (withKey) await saveInboxApiKey(path.join(profile, "inbox.key.json"), TEST_KEY);
  return profile;
}

function structured(result: ToolCallResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTruthy();
  return result.structuredContent as Record<string, unknown>;
}

function errorCode(result: ToolCallResult): string {
  expect(result.isError).toBe(true);
  return structured(result).code as string;
}

function text(result: ToolCallResult): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

const ARGS = {
  operationId: "op-capture-1",
  title: "Meeting notes",
  content: "# Agenda\n\n- one\n- two",
  format: "markdown" as const
};

async function receiptsOf(profile: string): Promise<InboxReceipt[]> {
  return new InboxReceiptStore(path.join(profile, "inbox.receipts.json")).list();
}

describe("capture_note: accepted capture", () => {
  it("sends exactly one bounded request and reports queueing only", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const result = await handler(ARGS, {});
    expect(result.isError).toBeFalsy();
    const body = structured(result);
    expect(captureNoteOutputSchema.safeParse(body).success).toBe(true);
    expect(body.status).toBe("inbox_accepted");
    expect(body.serverQueued).toBe(true);
    expect(body.importedToDevice).toBe(false);
    expect(body.noteId).toBeNull();
    expect(body.sync).toBe("unknown");
    expect(body.replayedFromReceipt).toBe(false);

    // The request body is exactly the documented payload (plus nothing).
    expect(sender.calls).toHaveLength(1);
    expect(JSON.parse(sender.calls[0].body)).toEqual({
      title: ARGS.title,
      type: "note",
      source: "veyran-connect",
      version: 1,
      content: { type: "html", data: "<h1>Agenda</h1><ul><li>one</li><li>two</li></ul>" }
    });
    // The key comes from the configured local profile, never from the model.
    expect(sender.calls[0].apiKey).toBe(TEST_KEY);

    // No claim of a local note, an import, a sync or a link — ever.
    const rendered = `${text(result)} ${JSON.stringify(body)}`;
    expect(rendered).toMatch(/queued/i);
    expect(rendered).not.toMatch(/local_saved|nn:\/\//i);
    // Nothing from the capture itself is echoed back.
    for (const secret of [ARGS.title, "Agenda", "one", "two"])
      expect(rendered).not.toContain(secret);
    // And the receipt is local, accepted, and bound to the payload hash.
    const receipts = await receiptsOf(profile);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ operationId: ARGS.operationId, state: "accepted" });
    expect(receipts[0].at).toBeGreaterThan(0);
  });
});

describe("capture_note: repeat safety", () => {
  it("returns the same accepted receipt without a second request", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const first = structured(await handler(ARGS, {}));
    const second = await handler({ ...ARGS }, {});
    expect(second.isError).toBeFalsy();
    const replay = structured(second);
    expect(replay).toEqual({ ...first, replayedFromReceipt: true });
    expect(sender.calls).toHaveLength(1);
    expect(await receiptsOf(profile)).toHaveLength(1);
  });

  it("refuses a reused operationId with different content (no request)", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    await handler(ARGS, {});
    const changed = await handler({ ...ARGS, content: "different body" }, {});
    expect(errorCode(changed)).toBe("IDEMPOTENCY_CONFLICT");
    expect(text(changed)).toBe(TOOL_ERROR_MESSAGES.IDEMPOTENCY_CONFLICT);
    const reTitled = await handler({ ...ARGS, title: "Another title" }, {});
    expect(errorCode(reTitled)).toBe("IDEMPOTENCY_CONFLICT");
    const reformatted = await handler({ ...ARGS, format: "plaintext" }, {});
    expect(errorCode(reformatted)).toBe("IDEMPOTENCY_CONFLICT");
    expect(sender.calls).toHaveLength(1);
  });

  it("treats a new operationId with the same content as a new capture", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    await handler(ARGS, {});
    await handler({ ...ARGS, operationId: "op-capture-2" }, {});
    expect(sender.calls).toHaveLength(2);
    expect(await receiptsOf(profile)).toHaveLength(2);
  });

  it("sends exactly once for two concurrent identical calls", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const [a, b] = await Promise.all([handler(ARGS, {}), handler(ARGS, {})]);
    expect(sender.calls).toHaveLength(1);
    const replays = [structured(a), structured(b)].filter(
      (entry) => entry.replayedFromReceipt === true
    );
    expect(replays).toHaveLength(1);
  });
});

describe("capture_note: uncertain and unreachable outcomes", () => {
  it("reports an unknown outcome honestly and never resends automatically", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "unconfirmed" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const first = await handler(ARGS, {});
    expect(errorCode(first)).toBe("INBOX_UNCERTAIN");
    expect(text(first)).toBe(TOOL_ERROR_MESSAGES.INBOX_UNCERTAIN);
    expect(text(first)).toMatch(/do not resend/i);
    expect(JSON.stringify(first)).not.toMatch(/inbox_accepted|serverQueued/);

    // The receipt records the *local* observation only: no remote status is
    // invented, and an exact retry does not send again.
    expect(await receiptsOf(profile)).toMatchObject([
      { operationId: ARGS.operationId, state: "uncertain" }
    ]);
    const retry = await handler(ARGS, {});
    expect(errorCode(retry)).toBe("INBOX_UNCERTAIN");
    expect(sender.calls).toHaveLength(1);

    // A different operationId is a new (deliberate) attempt.
    await handler({ ...ARGS, operationId: "op-capture-new" }, {});
    expect(sender.calls).toHaveLength(2);
  });

  it("converts an unexpected sender failure to an unknown outcome and keeps the write-ahead receipt", async () => {
    const profile = await tempProfile();
    const sender: InboxSender = {
      async send() {
        throw new Error("process died here");
      }
    };
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    const result = await handler(ARGS, {});
    expect(errorCode(result)).toBe("INBOX_UNCERTAIN");
    expect(text(result)).toBe(TOOL_ERROR_MESSAGES.INBOX_UNCERTAIN);
    expect(await receiptsOf(profile)).toMatchObject([{ state: "uncertain" }]);
    const retry = await handler(ARGS, {});
    expect(errorCode(retry)).toBe("INBOX_UNCERTAIN");
  });

  it("reports a provably unsent request as unavailable and allows a retry", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "not_sent" }, { kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const offline = await handler(ARGS, {});
    expect(errorCode(offline)).toBe("INBOX_UNAVAILABLE");
    expect(text(offline)).toBe(TOOL_ERROR_MESSAGES.INBOX_UNAVAILABLE);
    // Nothing reached the endpoint, so no receipt is kept and the retry sends.
    expect(await receiptsOf(profile)).toEqual([]);
    const retry = await handler(ARGS, {});
    expect(structured(retry).status).toBe("inbox_accepted");
    expect(sender.calls).toHaveLength(2);
  });

  it("maps documented refusals and keeps no receipt for them", async () => {
    const cases: [InboxOutcome, ToolErrorCode][] = [
      [{ kind: "refused", code: "INBOX_REJECTED" }, "INBOX_REJECTED"],
      [{ kind: "refused", code: "INBOX_UNAUTHORIZED" }, "INBOX_UNAUTHORIZED"],
      [{ kind: "refused", code: "INBOX_RATE_LIMITED" }, "INBOX_RATE_LIMITED"]
    ];
    for (const [outcome, expected] of cases) {
      const profile = await tempProfile();
      const sender = fakeSender([outcome]);
      const handler = createCaptureNoteHandler({ profileDir: profile, sender });
      const result = await handler(ARGS, {});
      expect(errorCode(result)).toBe(expected);
      expect(text(result)).toBe(TOOL_ERROR_MESSAGES[expected]);
      // A documented refusal means nothing was queued: no receipt, and a
      // corrected retry is legitimate.
      expect(await receiptsOf(profile)).toEqual([]);
      expect(sender.calls).toHaveLength(1);
    }
  });
});

describe("capture_note: configuration and recipient binding", () => {
  it("reports INBOX_NOT_CONFIGURED without sending when no key is stored", async () => {
    const profile = await tempProfile(false);
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    const result = await handler(ARGS, {});
    expect(errorCode(result)).toBe("INBOX_NOT_CONFIGURED");
    expect(text(result)).toBe(TOOL_ERROR_MESSAGES.INBOX_NOT_CONFIGURED);
    expect(sender.calls).toHaveLength(0);
    expect(await receiptsOf(profile)).toEqual([]);
  });

  it("fails closed on a corrupt or permission-unsafe key file", async () => {
    const profile = await tempProfile(false);
    const keyFile = path.join(profile, "inbox.key.json");
    await fs.writeFile(keyFile, JSON.stringify({ v: 1, createdAt: 1, apiKey: "short" }), {
      mode: 0o600
    });
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    expect(errorCode(await handler(ARGS, {}))).toBe("CONFIG_INVALID");

    await fs.writeFile(
      keyFile,
      JSON.stringify({ v: 1, createdAt: 1, apiKey: TEST_KEY }),
      { mode: 0o600 }
    );
    await fs.chmod(keyFile, 0o644);
    expect(errorCode(await handler(ARGS, {}))).toBe("CONFIG_INSECURE");
    expect(sender.calls).toHaveLength(0);
  });

  it("binds the recipient to the configured profile: no key or url from the model", async () => {
    const profileA = await tempProfile();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-inbox-tool-b-"));
    dirs.push(base);
    const profileB = path.join(base, "profile");
    await ensureSecureDir(profileB);
    await saveInboxApiKey(path.join(profileB, "inbox.key.json"), OTHER_KEY);

    const sender = fakeSender([{ kind: "accepted" }]);
    const handlerA = createCaptureNoteHandler({ profileDir: profileA, sender });
    const handlerB = createCaptureNoteHandler({ profileDir: profileB, sender });

    await handlerA(ARGS, {});
    await handlerB({ ...ARGS, operationId: "op-b" }, {});
    expect(sender.calls.map((call) => call.apiKey)).toEqual([TEST_KEY, OTHER_KEY]);
    // Receipts are per profile: the same operationId can be captured by both.
    expect(await receiptsOf(profileA)).toHaveLength(1);
    expect(await receiptsOf(profileB)).toHaveLength(1);

    // A model-supplied key/url/header is rejected by the strict schema.
    for (const extra of [
      { apiKey: "x".repeat(32) },
      { url: "https://evil.example/" },
      { headers: { authorization: "Bearer x" } }
    ]) {
      const result = await handlerA({ ...ARGS, operationId: "op-x", ...extra }, {});
      expect(errorCode(result)).toBe("INVALID_ARGUMENTS");
    }
    expect(sender.calls).toHaveLength(2);
    // The fixed endpoint is the official one, and it is a module constant.
    expect(INBOX_ENDPOINT_URL).toBe("https://inbox.notesnook.com/");
  });

  it("does not replay an accepted receipt after the configured recipient key changes", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    const accepted = await handler(ARGS, {});
    expect(structured(accepted).status).toBe("inbox_accepted");
    await saveInboxApiKey(path.join(profile, "inbox.key.json"), OTHER_KEY);

    const switchedRecipient = await handler(ARGS, {});
    expect(errorCode(switchedRecipient)).toBe("IDEMPOTENCY_CONFLICT");
    expect(sender.calls).toHaveLength(1);
    const stored = JSON.stringify(await receiptsOf(profile));
    expect(stored).not.toContain(TEST_KEY);
    expect(stored).not.toContain(OTHER_KEY);
  });
});

describe("capture_note: bounds, sanitization and redaction", () => {
  it("refuses malformed arguments and oversized captures before any request", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });

    expect(errorCode(await handler({ title: "no id" }, {}))).toBe("INVALID_ARGUMENTS");
    expect(
      errorCode(await handler({ ...ARGS, title: "  " }, {}))
    ).toBe("INVALID_ARGUMENTS");
    expect(
      errorCode(await handler({ ...ARGS, title: "x".repeat(600) }, {}))
    ).toBe("INVALID_ARGUMENTS");
    expect(
      errorCode(
        await handler(
          { ...ARGS, content: "x".repeat(INBOX_LIMITS.maxContentBytes + 1) },
          {}
        )
      )
    ).toBe("CONTENT_TOO_LARGE");
    expect(
      errorCode(await handler({ ...ARGS, content: "bad\u0007bell" }, {}))
    ).toBe("UNSUPPORTED_CONTENT");
    expect(sender.calls).toHaveLength(0);
    expect(await receiptsOf(profile)).toEqual([]);
  });

  it("cannot be cancelled before anything is written when already aborted", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    const controller = new AbortController();
    controller.abort();
    const result = await handler(ARGS, { mcpReq: { signal: controller.signal } });
    expect(errorCode(result)).toBe("CANCELLED");
    expect(sender.calls).toHaveLength(0);
    expect(await receiptsOf(profile)).toEqual([]);
  });

  it("sends hostile markdown only as escaped text with filtered links", async () => {
    const profile = await tempProfile();
    let sent = "";
    const sender = fakeSender([{ kind: "accepted" }], (body) => {
      sent = body;
    });
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    const hostile = [
      "<script>steal()</script>",
      '<img src=x onerror="steal()">',
      "[click](javascript:steal())",
      "[ok](https://example.com/a?b=1&c=2)",
      "[__proto__](https://example.com/#)"
    ].join("\n\n");

    const result = await handler({ ...ARGS, content: hostile }, {});
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(sent) as { content: { data: string } };
    const data = payload.content.data;
    // No element, attribute or script address from the capture survives as
    // markup: hostile markup exists only as escaped text.
    expect(data).not.toMatch(/<(?:script|img)\b/i);
    expect(data).not.toMatch(/<[^>]*\son(?:error|click|load)\s*=/i);
    expect(data).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(data).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
    // Both real https addresses survive; the `javascript:` one does not.
    expect([...data.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "https://example.com/a?b=1&amp;c=2",
      "https://example.com/#"
    ]);
    // The request body carries the key nowhere: it is a header-only secret.
    expect(sent).not.toContain(TEST_KEY);
    // And nothing hostile is reflected back to the model.
    expect(JSON.stringify(result)).not.toContain("steal");
  });

  it("never leaks the key, the title or the body into an error result", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([
      { kind: "refused", code: "INBOX_UNAUTHORIZED" },
      { kind: "unconfirmed" }
    ]);
    const handler = createCaptureNoteHandler({ profileDir: profile, sender });
    const secretTitle = "Sensitive title";
    const secretBody = "account-number-1234";
    const args = { operationId: "op-leak", title: secretTitle, content: secretBody };

    for (const _ of [0, 1]) {
      const result = await handler({ ...args, operationId: `op-leak-${_}` }, {});
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(TEST_KEY);
      expect(rendered).not.toContain(secretTitle);
      expect(rendered).not.toContain(secretBody);
      expect(rendered).not.toContain(TEST_KEY.slice(0, 12));
    }
  });
});

describe("capture_note: registration and the official SDK path", () => {
  it("registers one truthful, strict tool next to the Core tools", () => {
    const registered: {
      name: string;
      config: Record<string, unknown>;
      handler: unknown;
    }[] = [];
    const registrar = {
      registerTool: (name: string, config: unknown, handler: unknown) => {
        registered.push({ name, config: config as Record<string, unknown>, handler });
      }
    } as unknown as ToolRegistrar;

    registerCaptureNote(registrar, { profileDir: "/nonexistent-profile" });
    expect(registered).toHaveLength(1);
    const [tool] = registered;
    expect(tool.name).toBe(CAPTURE_NOTE_TOOL_NAME);
    expect(tool.name).not.toBe("create_note");
    expect(String(tool.config.description)).toMatch(/not create_note/i);
    expect(String(tool.config.description)).toMatch(/no note id/i);
    expect(String(tool.config.description)).toMatch(/do not resend/i);
    expect(CAPTURE_NOTE_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });

    const inputShape = (tool.config.inputSchema as { shape: Record<string, unknown> })
      .shape;
    expect(Object.keys(inputShape).sort()).toEqual([
      "content",
      "format",
      "operationId",
      "title"
    ]);
    // No key, url, header, proxy or operation field is visible to the model.
    for (const forbidden of ["apiKey", "key", "url", "endpoint", "headers", "proxy", "operation"])
      expect(Object.keys(inputShape)).not.toContain(forbidden);
  });

  it("works through the real MCP server over the SDK's in-memory transport", async () => {
    const profile = await tempProfile();
    const sender = fakeSender([{ kind: "accepted" }]);
    const server = buildMcpServer({ profileDir: profile, inboxSender: sender });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "veyran-inbox-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(CAPTURE_NOTE_TOOL_NAME);
      // The Core tool list is untouched; capture_note is the only addition.
      expect(names).toHaveLength(13);
      const capture = tools.find((tool) => tool.name === CAPTURE_NOTE_TOOL_NAME);
      expect(capture?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      });
      const properties = Object.keys(
        (capture?.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {}
      );
      expect(properties.sort()).toEqual(["content", "format", "operationId", "title"]);

      // The SDK validates the declared output schema for a success result.
      const accepted = await client.callTool({
        name: CAPTURE_NOTE_TOOL_NAME,
        arguments: ARGS
      });
      expect(accepted.isError).toBeFalsy();
      expect(accepted.structuredContent).toMatchObject({
        operationId: ARGS.operationId,
        status: "inbox_accepted",
        serverQueued: true,
        importedToDevice: false,
        noteId: null,
        sync: "unknown"
      });

      const failed = await client.callTool({
        name: CAPTURE_NOTE_TOOL_NAME,
        arguments: { ...ARGS, operationId: "op-other", content: "x" }
      });
      // A second, different capture is accepted by the same fake sender.
      expect(failed.isError).toBeFalsy();
      expect(sender.calls).toHaveLength(2);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("surfaces INBOX_NOT_CONFIGURED through the real MCP server", async () => {
    // (see the suite below for the full not-configured coverage)
    const profile = await tempProfile(false);
    const sender = fakeSender([{ kind: "accepted" }]);
    const server = buildMcpServer({ profileDir: profile, inboxSender: sender });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "veyran-inbox-test-2", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: CAPTURE_NOTE_TOOL_NAME,
        arguments: ARGS
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { code?: string }).code).toBe(
        "INBOX_NOT_CONFIGURED"
      );
      expect(sender.calls).toHaveLength(0);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

describe("capture_note: fixed destination, verified statically", () => {
  /**
   * Strip the GPL block header (and every other block comment) so a check is
   * about code, not prose. Line comments are left in place here, so a URL
   * literal inside a code line is not truncated.
   */
  function withoutBlockComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  /** Strip every comment, for identifier-level checks. */
  function executableText(source: string): string {
    return withoutBlockComments(source)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  it("names exactly one HTTPS endpoint and never follows a redirect", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/inbox-transport.ts"),
      "utf8"
    );
    const body = withoutBlockComments(source);
    const endpoints = new Set(
      [...body.matchAll(/https?:\/\/[^\s"'`]+/g)].map((match) => match[0])
    );
    expect([...endpoints]).toEqual(["https://inbox.notesnook.com/"]);

    const code = executableText(source);
    expect(code).toMatch(/from "node:https"/);
    expect(code).not.toMatch(/node:http['"]|require\(["']http["']\)/);
    // No redirect handling of any kind: the status/`location` of a 3xx is never
    // inspected, so a redirect can only ever be classified as unconfirmed.
    expect(code).not.toMatch(/\blocation\b|\bredirect\b|\bfollow\b/i);
    expect(code).not.toMatch(/process\.env|process\.argv|process\.cwd/);
    expect(code).toMatch(/rejectUnauthorized: true/);
    expect(code).toMatch(/minVersion: "TLSv1\.2"/);
    expect(code).toMatch(/INBOX_LIMITS\.maxResponseBytes/);
    expect(code).toMatch(/INBOX_LIMITS\.maxRequestBytes/);
  });

  it("never reads a key or an endpoint from the environment or argv", async () => {
    for (const file of ["inbox-tool.ts", "inbox-format.ts", "inbox-profile.ts"]) {
      const source = await fs.readFile(path.join(process.cwd(), "src", file), "utf8");
      // No URL literal at all in these modules: the endpoint exists only in
      // `inbox-transport.ts` (and the GPL header, which is a block comment).
      expect(withoutBlockComments(source)).not.toMatch(/https?:\/\//);
      expect(executableText(source)).not.toMatch(/process\.env|process\.argv/);
    }
  });

  it("takes the key only from the CLI's hidden prompt, never from argv", async () => {
    const cli = await fs.readFile(path.join(process.cwd(), "src/cli.ts"), "utf8");
    const code = executableText(cli);
    expect(code).toMatch(/promptHiddenKey\(/);
    expect(code).toMatch(/flags\.key !== undefined/);
    expect(code).toMatch(/inboxApiKeySchema\.safeParse/);
    // The key is written only through the atomic 0600 writer.
    expect(code).toMatch(/saveInboxApiKey\(paths\.inboxKey, parsed\.data\)/);
    // Diagnostics never interpolate the key.
    expect(code).not.toMatch(/reportDiagnostic\([^)]*parsed\.data\.apiKey/);
  });
});

describe("capture_note: handler type surface", () => {
  it("is a plain ToolHandler (no broker, no app, no attach)", async () => {
    const handler: ToolHandler = createCaptureNoteHandler({
      profileDir: await tempProfile(false),
      sender: fakeSender([{ kind: "accepted" }])
    });
    const result = await handler({ operationId: "op-1", title: "t" }, {});
    expect(errorCode(result)).toBe("INBOX_NOT_CONFIGURED");
  });
});

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
 * End-to-end tool tests over the true route:
 *
 *   createToolHandler → BrokerClient (pinned HTTPS) → Broker (HTTPS listener)
 *     → AppConnection (pinned HTTPS) → the real Core ConnectAdapter
 *       → real synthetic encrypted SQLite fixture
 *
 * There is no in-process dispatch shortcut: the MCP half only ever talks to the
 * broker over TLS, and the app half is a separate TLS client driving Core.
 */
import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  createHarness,
  openConnectDb,
  signIn,
  type ConnectHarness
} from "../../../packages/core/__tests__/connect/fixtures.js";
import { ConnectAdapter } from "../../../packages/core/src/connect/adapter.js";
import { createToolHandler, type ToolCallResult } from "../src/tools.js";
import type { AttachResult } from "../src/attach.js";
import { BrokerClient } from "../src/client.js";
import type { ConnectOperation } from "../src/contract.js";
import {
  AppConnection,
  makeProfile,
  startAppLoop,
  startBroker,
  type StartedBroker,
  type TestProfile
} from "./harness.js";

interface Route {
  started: StartedBroker;
  callTool: (
    operation: ConnectOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<ToolCallResult>;
  switchAdapter: (adapter: ConnectAdapter, accountId: string) => Promise<void>;
  stop: () => Promise<void>;
}

const routes: Route[] = [];
const fixtures: ConnectHarness[] = [];
const brokers: StartedBroker[] = [];

afterEach(async () => {
  for (const route of routes.splice(0)) await route.stop();
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const fixture of fixtures.splice(0)) await fixture.close().catch(() => undefined);
});

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function bootRoute(
  adapter: ConnectAdapter,
  accountId: string,
  profile: TestProfile
): Promise<Route> {
  const started = await startBroker(profile);
  const app = new AppConnection({
    port: started.port,
    credential: profile.credentials.app,
    rootPem: profile.tls.rootPem,
    leafPin: profile.tls.leafPin
  });
  await app.session(accountId, 1);
  let current = adapter;
  const loop = startAppLoop(app, "app-cli", (request) => current.execute(request));
  const client = new BrokerClient({
    port: started.port,
    credential: profile.credentials.mcp,
    rootPem: profile.tls.rootPem,
    leafPin: profile.tls.leafPin,
    timeoutMs: 10_000
  });
  const attach = async (): Promise<AttachResult> => ({
    ok: true,
    client,
    config: {
      v: 1,
      brokerId: started.broker.brokerId,
      port: started.port,
      client: profile.credentials.mcp,
      tls: { rootPem: profile.tls.rootPem, leafPin: profile.tls.leafPin }
    }
  });
  const route: Route = {
    started,
    callTool: (operation, args, signal) =>
      createToolHandler(operation, attach)(args, signal ? { mcpReq: { signal } } : {}),
    switchAdapter: async (next, nextAccount) => {
      current = next;
      await app.session(nextAccount, 1);
    },
    stop: async () => {
      loop.stop();
      await started.stop();
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    }
  };
  routes.push(route);
  return route;
}

async function harnessRoute(): Promise<{ harness: ConnectHarness; route: Route }> {
  const harness = await createHarness();
  fixtures.push(harness);
  const profile = await makeProfile();
  const route = await bootRoute(harness.adapter, harness.accountId, profile);
  return { harness, route };
}

function structured(result: ToolCallResult): Record<string, unknown> {
  expect(result.structuredContent).toBeTruthy();
  return result.structuredContent as Record<string, unknown>;
}

function errorCode(result: ToolCallResult): string {
  expect(result.isError).toBe(true);
  return structured(result).code as string;
}

/**
 * Bounded, never-throwing context for a possibly-failed tool result: the
 * structured error code when the envelope carries one, else a fixed marker.
 * Used only to make a failing success-path assertion legible.
 */
function failureContext(result: ToolCallResult): string {
  const body = result.structuredContent as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : "no-structured-code";
}

describe("tools over the true broker + Core route", () => {
  it("reports status without fabricating availability", async () => {
    const { route } = await harnessRoute();
    const result = await route.callTool("status", {});
    const body = structured(result);
    expect(body.operation).toBe("status");
    expect(body.account).toBe("signed_in");
    expect(["ready", "locked"]).toContain(body.status);
    expect(body.sync).toBe("unknown");
    expect(result.isError).toBeFalsy();
  });

  it("creates, reads, appends, updates and searches notes", async () => {
    const { harness, route } = await harnessRoute();
    const created = await route.callTool("create_note", {
      operationId: "op-create-1",
      notebookId: harness.notebookId,
      title: "Unicode ✍️ note",
      content: "- one\n- two\n\n[label](https://example.com)",
      format: "markdown"
    });
    const createdBody = structured(created);
    expect(createdBody.persisted).toBe("local_saved");
    expect(createdBody.sync).toBe("unknown");
    expect(createdBody.url).toBe(`nn://note/${createdBody.noteId}`);
    const noteId = createdBody.noteId as string;
    const revision = createdBody.revision as string;

    const got = structured(await route.callTool("get_note", { noteId }));
    expect(got.format).toBe("tiptap");
    expect(got.url).toBe(`nn://note/${noteId}`);
    expect(String(got.content).length).toBeGreaterThan(0);

    const appended = await route.callTool("append_to_note", {
      operationId: "op-append-1",
      noteId,
      content: "\nappended ✅",
      format: "plaintext",
      expectedRevision: revision
    });
    expect(structured(appended).persisted).toBe("local_saved");

    const updated = await route.callTool("update_note", {
      operationId: "op-update-1",
      noteId,
      expectedRevision: structured(appended).revision as string,
      patch: { title: "Renamed note", pinned: true }
    });
    expect(structured(updated).persisted).toBe("local_saved");

    const searched = structured(await route.callTool("search_notes", { query: "Renamed" }));
    expect(Array.isArray(searched.results)).toBe(true);
    expect((searched.results as unknown[]).length).toBeGreaterThan(0);
    expect(searched.sync).toBe("unknown");

    const notebooks = structured(await route.callTool("list_notebooks", {}));
    const notebookIds = (notebooks.notebooks as { id: string }[]).map((n) => n.id);
    expect(notebookIds).toContain(harness.notebookId);

    const lists = structured(await route.callTool("list_task_lists", {}));
    const listIds = (lists.lists as { id: string }[]).map((entry) => entry.id);
    expect(listIds).toContain(harness.listId);
  });

  it("refuses a stale expectedRevision with the Core conflict code", async () => {
    const { harness, route } = await harnessRoute();
    const result = await route.callTool("append_to_note", {
      operationId: "op-stale-1",
      noteId: harness.noteId,
      content: "x",
      format: "plaintext",
      expectedRevision: "not-the-current-revision"
    });
    expect(errorCode(result)).toBe("REVISION_CONFLICT");
  });

  it("creates, lists, updates and completes tasks with truthful fields", async () => {
    const { harness, route } = await harnessRoute();
    const created = await route.callTool("create_task", {
      operationId: "op-task-1",
      title: "Task ✳️",
      listId: harness.listId,
      // The Connect adapter always forwards *own* `reminderDate`/`reminderTime`
      // keys into Core `Tasks.create`, which makes the calendar branch
      // (`reminderDate`/`reminderTime` present, `scheduleVersion` 2) the only
      // live reminder path and ignores a bare legacy `reminderAt`. So a genuine
      // recurring + urgent Task must supply the explicit floating calendar
      // fields: a recurring Task requires `dueDate`, and `urgent` requires a
      // resolvable reminder date *and* time. All four are floating wall-clock
      // values — there is no timezone parameter.
      dueDate: "2030-01-02",
      dueTime: "03:04",
      reminderDate: "2030-01-02",
      reminderTime: "03:04",
      priority: "high",
      flagged: true,
      urgent: true,
      recurrenceRule: "FREQ=DAILY;COUNT=3"
    });
    // Assert success *before* unwrapping the structured result, so a failure
    // surfaces as the real error envelope rather than a confusing unwrap.
    // A successful tool result deliberately omits `isError` (the SDK permits
    // `undefined`; only an error envelope sets it to `true`), so assert
    // falsiness, not `false`, and carry the bounded structured code as context.
    expect(
      created.isError,
      `create_task failed: ${failureContext(created)}`
    ).toBeFalsy();
    const createdBody = structured(created);
    expect(createdBody.persisted).toBe("local_saved");
    expect(createdBody.link).toBe(`veyran://task/${createdBody.taskId}`);

    const listedBody = structured(
      await route.callTool("list_tasks", { listId: harness.listId })
    );
    const tasks = listedBody.tasks as Record<string, unknown>[];
    const task = tasks.find((entry) => entry.taskId === createdBody.taskId);
    expect(task).toBeTruthy();
    // The stored, returned floating calendar schedule is exactly what was
    // written (no timezone conversion): reminder and due mirror the fixture.
    expect(task?.dueDate).toBe("2030-01-02");
    expect(task?.dueTime).toBe("03:04");
    expect(task?.reminderDate).toBe("2030-01-02");
    expect(task?.reminderTime).toBe("03:04");
    // `urgent` survives the round-trip and the recurrence is preserved.
    expect(task?.urgent).toBe(true);
    expect(task?.recurrenceRule).toBe("FREQ=DAILY;COUNT=3");
    expect(typeof task?.flagged).toBe("boolean");
    expect(task?.priority).toBe("high");

    const updated = await route.callTool("update_task", {
      operationId: "op-task-update-1",
      taskId: createdBody.taskId,
      expectedRevision: createdBody.revision,
      patch: { flagged: false, priority: "low" }
    });
    expect(structured(updated).persisted).toBe("local_saved");
    expect(structured(updated).completed).toBe(false);

    const completed = await route.callTool("complete_task", {
      operationId: "op-complete-1",
      taskId: createdBody.taskId,
      expectedRevision: structured(updated).revision as string
    });
    expect(structured(completed).completed).toBe(true);
    expect(structured(completed).sync).toBe("unknown");
  });

  it("reports a locked adapter and a cancelled call honestly", async () => {
    const { harness, route } = await harnessRoute();
    harness.adapter.lock();
    const lockedStatus = await route.callTool("status", {});
    expect(structured(lockedStatus).status).toBe("locked");
    expect(structured(lockedStatus).available).toBe(false);
    const lockedWrite = await route.callTool("create_note", {
      operationId: "op-locked",
      content: "x",
      format: "plaintext"
    });
    expect(errorCode(lockedWrite)).toBe("ADAPTER_LOCKED");
    harness.adapter.unlock();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await route.callTool("status", {}, controller.signal);
    expect(errorCode(cancelled)).toBe("CANCELLED");
  });

  it("honestly reports a missing broker", async () => {
    const result = await createToolHandler("status", async () => ({
      ok: false,
      code: "BROKER_UNAVAILABLE"
    }))({}, {});
    expect(errorCode(result)).toBe("BROKER_UNAVAILABLE");
  });
});

describe("tool response correlation", () => {
  function fakeAttach(client: Record<string, unknown>): () => Promise<AttachResult> {
    return async () => ({
      ok: true,
      client: client as unknown as BrokerClient,
      config: {
        v: 1,
        brokerId: "0".repeat(32),
        port: 1,
        client: { id: "0".repeat(32), secret: "A".repeat(43) },
        tls: { rootPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", leafPin: "0".repeat(64) }
      }
    });
  }

  it("refuses an uncorrelated result", async () => {
    const fakeClient = {
      submit: async () => ({ ok: true as const, result: { ticketId: "0".repeat(32) } }),
      awaitResponse: async () => ({
        ok: true as const,
        result: {
          response: {
            ok: true,
            result: {
              operation: "create_note",
              operationId: "x",
              noteId: "note-000000000000000000000001",
              revision: "r",
              url: "nn://note/n",
              persisted: "local_saved",
              sync: "unknown"
            }
          }
        }
      }),
      cancel: async () => ({
        ok: true as const,
        result: { removed: false, uncertain: true, completed: false }
      })
    };
    const result = await createToolHandler(
      "get_note",
      fakeAttach(fakeClient)
    )({ noteId: "note-000000000000000000000001" }, {});
    expect(errorCode(result)).toBe("UNCORRELATED_RESULT");
  });

  it("reports an uncertain cancel honestly and never a saved result", async () => {
    const controller = new AbortController();
    const fakeClient = {
      submit: async () => {
        controller.abort();
        return { ok: true as const, result: { ticketId: "0".repeat(32) } };
      },
      awaitResponse: async () => {
        throw new Error("aborted");
      },
      cancel: async () => ({
        ok: true as const,
        result: { removed: false, uncertain: true, completed: false }
      })
    };
    const result = await createToolHandler(
      "create_note",
      fakeAttach(fakeClient)
    )({ operationId: "op-1", content: "x", format: "plaintext" }, {
      mcpReq: { signal: controller.signal }
    });
    expect(errorCode(result)).toBe("IDEMPOTENCY_UNCERTAIN");
  });

  it("treats a transport failure on a write as uncertain, not unavailable", async () => {
    const fakeClient = {
      submit: async () => ({ ok: true as const, result: { ticketId: "0".repeat(32) } }),
      awaitResponse: async () => {
        throw new Error("socket closed");
      },
      cancel: async () => ({ ok: true as const, result: { removed: true, uncertain: false, completed: false } })
    };
    const result = await createToolHandler(
      "update_note",
      fakeAttach(fakeClient)
    )({
      operationId: "op-1",
      noteId: "note-000000000000000000000001",
      expectedRevision: "r",
      patch: { title: "x" }
    }, {});
    expect(errorCode(result)).toBe("IDEMPOTENCY_UNCERTAIN");
  });
});

describe("durable receipts across a database restart", () => {
  it("applies the same operationId exactly once across reopen", async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `veyran-connect-restart-${randomBytes(8).toString("hex")}.sql`
    );
    const first = await createHarness({ dbPath });
    const profile = await makeProfile();
    const firstRoute = await bootRoute(first.adapter, first.accountId, profile);
    const created = structured(
      await firstRoute.callTool("create_note", {
        operationId: "op-restart-1",
        notebookId: first.notebookId,
        title: "Restart note",
        content: "body",
        format: "plaintext"
      })
    );
    const firstId = created.noteId as string;
    await firstRoute.stop();
    await first.close();

    const fixture = await openConnectDb(dbPath);
    fixtures.push({
      ...fixture,
      adapter: new ConnectAdapter(fixture.db),
      accountId: "acct-1",
      notebookId: first.notebookId,
      noteId: first.noteId,
      listId: first.listId
    });
    const accountId = await signIn(fixture.db, "acct-1");
    const adapter = new ConnectAdapter(fixture.db);
    await adapter.setGrants({
      accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [first.notebookId],
      noteIDs: [first.noteId],
      listIDs: [first.listId]
    });
    const secondRoute = await bootRoute(adapter, accountId, profile);
    const replay = structured(
      await secondRoute.callTool("create_note", {
        operationId: "op-restart-1",
        notebookId: first.notebookId,
        title: "Restart note",
        content: "body",
        format: "plaintext"
      })
    );
    expect(replay.noteId).toBe(firstId);
    adapter.close();
  });
});

describe("bounded large content and in-flight cancellation", () => {
  it("round-trips a >1 MiB note body and fails closed above the Core read cap", async () => {
    const harness = await createHarness();
    fixtures.push(harness);
    // Seed bodies directly through the Core domain (bypassing the 100k-char
    // request cap): the point is the *read* path — a broker `reply` above the
    // 1 MiB caller cap — and the Core response cap of 1M chars.
    const bigHtml = `<p>${"é".repeat(999_000)}</p>`; // <1M chars, ~2 MiB UTF-8
    const hugeHtml = `<p>${"é".repeat(1_000_100)}</p>`; // >1M chars => cap
    const bigId = await harness.db.notes.add({
      title: "Big",
      content: { type: "tiptap", data: bigHtml }
    });
    const hugeId = await harness.db.notes.add({
      title: "Huge",
      content: { type: "tiptap", data: hugeHtml }
    });
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [harness.notebookId],
      noteIDs: [harness.noteId, bigId, hugeId],
      listIDs: [harness.listId]
    });
    const route = await bootRoute(
      harness.adapter,
      harness.accountId,
      await makeProfile()
    );

    const got = structured(await route.callTool("get_note", { noteId: bigId }));
    const content = got.content as string;
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(content.length).toBeLessThanOrEqual(1_000_000);

    const tooLarge = await route.callTool("get_note", { noteId: hugeId });
    expect(errorCode(tooLarge)).toBe("CONTENT_TOO_LARGE");
  });

  it("reports an uncertain write when a claimed request is aborted in flight", async () => {
    const profile = await makeProfile();
    const started = await startBroker(profile);
    brokers.push(started);
    const app = new AppConnection({
      port: started.port,
      credential: profile.credentials.app,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin
    });
    await app.session("acct-1");
    const client = new BrokerClient({
      port: started.port,
      credential: profile.credentials.mcp,
      rootPem: profile.tls.rootPem,
      leafPin: profile.tls.leafPin,
      timeoutMs: 5_000
    });
    const attach = async (): Promise<AttachResult> => ({
      ok: true,
      client,
      config: {
        v: 1,
        brokerId: started.broker.brokerId,
        port: started.port,
        client: profile.credentials.mcp,
        tls: { rootPem: profile.tls.rootPem, leafPin: profile.tls.leafPin }
      }
    });

    const controller = new AbortController();
    const pending = createToolHandler("create_note", attach)(
      { operationId: "op-abort-1", content: "x", format: "plaintext" },
      { mcpReq: { signal: controller.signal } }
    );

    // Wait until the write is enqueued, then claim it and never reply.
    await waitFor(() => started.broker.queueDepth >= 1);
    const claimed = await app.claim("app-cli");
    expect(claimed.ok).toBe(true);

    // Aborting an already-claimed write can only be reported as uncertain: the
    // app may have persisted it, so no retry is attempted blindly.
    controller.abort();
    const result = await pending;
    expect(errorCode(result)).toBe("IDEMPOTENCY_UNCERTAIN");
  });
});

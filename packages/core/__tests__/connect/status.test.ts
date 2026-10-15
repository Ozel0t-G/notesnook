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

import { describe, it, expect, afterEach } from "vitest";
import { createHarness, ConnectHarness } from "./fixtures.js";
import { responseSchema } from "../../src/connect/schema.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

describe("VeyraN Connect status contract", () => {
  it("reports version, granted capabilities and journal pressure", async () => {
    harness = await createHarness();
    const status = (await harness.adapter.execute({
      operation: "status"
    })) as {
      version: number;
      account: string;
      status: string;
      available: boolean;
      grantsGeneration: number;
      capabilities: Record<string, boolean>;
      journal: { capacity: number; count: number };
      sync: string;
    };

    expect(status.version).toBe(1);
    expect(status.account).toBe("signed_in");
    expect(status.status).toBe("ready");
    expect(status.available).toBe(true);
    expect(status.sync).toBe("unknown");
    // All four capabilities were granted by the harness.
    expect(status.capabilities).toEqual({
      read: true,
      create: true,
      change: true,
      task: true
    });
    expect(status.journal.capacity).toBe(1000);
    expect(status.journal.count).toBe(0);
    // The response validates against the strict shared contract.
    expect(responseSchema.safeParse(status).success).toBe(true);
  });

  it("derives capabilities from the actually installed grants", async () => {
    harness = await createHarness();
    await harness.adapter.setGrants({
      accountId: harness.accountId,
      canRead: true
    });
    const status = (await harness.adapter.execute({
      operation: "status"
    })) as { capabilities: Record<string, boolean> };
    expect(status.capabilities).toEqual({
      read: true,
      create: false,
      change: false,
      task: false
    });
  });

  it("stays callable while locked and leaks no ids or read scope", async () => {
    harness = await createHarness();
    harness.adapter.lock();
    const status = (await harness.adapter.execute({
      operation: "status"
    })) as { status: string; available: boolean };

    expect(status.status).toBe("locked");
    expect(status.available).toBe(false);

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(harness.noteId);
    expect(serialized).not.toContain(harness.notebookId);
    expect(serialized).not.toContain(harness.listId);
    // No read-scope/title fields whatsoever.
    expect(serialized).not.toContain("Note 1");
    expect(serialized).not.toContain("query");
    expect(responseSchema.safeParse(status).success).toBe(true);
  });
});

describe("VeyraN Connect read links", () => {
  it("returns the actual nn:// note url on get_note and search_notes", async () => {
    harness = await createHarness();

    const note = (await harness.adapter.execute({
      operation: "get_note",
      noteId: harness.noteId
    })) as { noteId: string; url: string };
    expect(note.url).toBe(`nn://note/${harness.noteId}`);

    const search = (await harness.adapter.execute({
      operation: "search_notes",
      query: "Note 1"
    })) as { results: { noteId: string; url: string }[] };
    expect(search.results.map((result) => result.noteId)).toContain(
      harness.noteId
    );
    for (const result of search.results)
      expect(result.url).toBe(`nn://note/${result.noteId}`);
  });

  it("returns the actual veyran:// link and real schedule fields on list_tasks", async () => {
    harness = await createHarness();
    const task = await harness.db.tasks.create({
      title: "Scheduled task",
      listId: harness.listId,
      urgent: true,
      flagged: true,
      recurrenceRule: "FREQ=DAILY",
      reminderDate: "2026-01-02",
      reminderTime: "09:30",
      reminderAt: 1_700_000_000_000,
      dueDate: "2026-01-02",
      dueTime: "09:00",
      priority: "high"
    });

    const listed = (await harness.adapter.execute({
      operation: "list_tasks"
    })) as {
      tasks: {
        taskId: string;
        link: string;
        flagged: boolean;
        urgent?: boolean;
        recurrenceRule?: string;
        reminderDate?: string;
        reminderTime?: string;
        reminderAt?: number;
      }[];
    };

    const entry = listed.tasks.find((item) => item.taskId === task.id);
    expect(entry).toBeTruthy();
    expect(entry!.link).toBe(`veyran://task/${task.id}`);
    expect(entry!.flagged).toBe(true);
    expect(entry!.urgent).toBe(true);
    expect(entry!.recurrenceRule).toBe("FREQ=DAILY");
    expect(entry!.reminderDate).toBe("2026-01-02");
    expect(entry!.reminderTime).toBe("09:30");
    // `create` normalizes reminderAt from the floating reminderDate/reminderTime
    // wall-clock (see tasks.ts calendarWrite path), so assert against the
    // domain-normalized value rather than the raw input literal.
    expect(entry!.reminderAt).toBe(task.reminderAt);
    expect(responseSchema.safeParse(listed).success).toBe(true);
  });
});

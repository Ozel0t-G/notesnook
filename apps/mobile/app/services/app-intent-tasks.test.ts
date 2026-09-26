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

// The Shortcuts "Complete Task" action now selects a real Task instead of
// matching a title string. These cover what the picker is allowed to show, what
// a saved parameter is allowed to address, and what a saved parameter means once
// its recurring occurrence has moved on.

import type { Task } from "@notesnook/core";
import {
  MAX_TASK_ENTITY_IDS,
  buildTaskEntityCandidates,
  decodeTaskEntityId,
  decodeTaskEntityIds,
  encodeTaskEntityId,
  matchOpenTasks,
  rankOpenTasks,
  resolveTaskCompletionTarget,
  taskEntitySubtitle,
  type TaskEntityContext
} from "./app-intent-tasks";

const SCOPE = "0123456789abcdef0123456789abcdef";
const OTHER_SCOPE = "f".repeat(32);
const TODAY = "2026-09-26";

const labels = {
  untitled: "Untitled",
  overdue: "Overdue",
  today: "Due today",
  due: (date: string) => `Due ${date}`,
  completed: "Completed"
};

const context: TaskEntityContext = {
  scope: SCOPE,
  today: TODAY,
  listNames: { personal: "Personal", work: "Work" },
  labels
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    listId: "personal",
    completed: false,
    priority: "none",
    flagged: false,
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    // The calendar schedule fields are only authoritative at version 2.
    scheduleVersion: 2,
    ...overrides
  } as Task;
}

describe("Shortcuts Task entity identifiers", () => {
  test("an identifier carries the account it was issued for", () => {
    const id = encodeTaskEntityId(SCOPE, "a".repeat(24));
    expect(id).toBe(`${SCOPE}:${"a".repeat(24)}`);
    expect(decodeTaskEntityId(id, SCOPE)).toBe("a".repeat(24));
    // A Shortcut saved before signing into another account addresses nothing,
    // which matters because migrated and recurring Task ids are derived rather
    // than random and could otherwise exist in two databases.
    expect(decodeTaskEntityId(id, OTHER_SCOPE)).toBeUndefined();
  });

  test("nothing but a well formed identifier can name a Task", () => {
    for (const invalid of [
      null,
      42,
      "",
      SCOPE,
      `${SCOPE}:`,
      `${SCOPE}:${"a".repeat(23)}`,
      `${SCOPE}:${"a".repeat(25)}`,
      `${SCOPE}:../../etc/passwd`,
      `${SCOPE}:${"a".repeat(24)}:extra`,
      `${"a".repeat(31)}:${"a".repeat(24)}`
    ])
      expect(decodeTaskEntityId(invalid, SCOPE)).toBeUndefined();
    expect(encodeTaskEntityId("not-a-scope", "a".repeat(24))).toBeUndefined();
    expect(encodeTaskEntityId(SCOPE, "nope")).toBeUndefined();
  });

  test("a resolution request is bounded, deduplicated and scope filtered", () => {
    const own = `${SCOPE}:${"a".repeat(24)}`;
    expect(
      decodeTaskEntityIds(
        JSON.stringify([own, own, `${OTHER_SCOPE}:${"b".repeat(24)}`, "junk"]),
        SCOPE
      )
    ).toEqual(["a".repeat(24)]);
    expect(
      decodeTaskEntityIds(
        JSON.stringify(Array(MAX_TASK_ENTITY_IDS + 1).fill(own)),
        SCOPE
      )
    ).toBeUndefined();
    expect(decodeTaskEntityIds("not json", SCOPE)).toBeUndefined();
    expect(decodeTaskEntityIds(JSON.stringify({}), SCOPE)).toBeUndefined();
  });
});

describe("Shortcuts Task picker contents", () => {
  test("suggestions put what is due first and leave completed Tasks out", () => {
    const overdue = task("a".repeat(24), { reminderDate: "2026-09-20" });
    const today = task("b".repeat(24), {
      reminderDate: TODAY,
      reminderTime: "09:00"
    });
    const upcoming = task("c".repeat(24), { reminderDate: "2026-10-01" });
    const flagged = task("d".repeat(24), { flagged: true, updatedAt: 5 });
    const plain = task("e".repeat(24), { updatedAt: 9 });
    const done = task("f".repeat(24), { completed: true });
    expect(
      rankOpenTasks(
        [plain, done, upcoming, flagged, today, overdue],
        TODAY
      ).map((entry) => entry.id)
    ).toEqual([overdue.id, today.id, upcoming.id, flagged.id, plain.id]);
  });

  test("a search prefers an exact title, then a prefix, then a substring", () => {
    const exact = task("a".repeat(24), { title: "Call Alex" });
    const prefix = task("b".repeat(24), { title: "Call Alex back" });
    const inside = task("c".repeat(24), { title: "Remember to call alex" });
    const unrelated = task("d".repeat(24), { title: "Buy milk" });
    expect(
      matchOpenTasks([unrelated, inside, prefix, exact], "call alex", TODAY).map(
        (entry) => entry.id
      )
    ).toEqual([exact.id, prefix.id, inside.id]);
    // An empty search is the plain suggestion list, not an empty picker.
    expect(matchOpenTasks([unrelated], "   ", TODAY)).toHaveLength(1);
  });

  test("two Tasks with the same title are told apart by List and schedule", () => {
    const first = task("a".repeat(24), {
      title: "Call Alex",
      reminderDate: "2026-09-20"
    });
    const second = task("b".repeat(24), {
      title: "Call Alex",
      listId: "work",
      reminderDate: TODAY
    });
    const candidates = buildTaskEntityCandidates([first, second], context);
    expect(candidates).toEqual([
      {
        id: `${SCOPE}:${first.id}`,
        title: "Call Alex",
        subtitle: "Personal · Overdue"
      },
      {
        id: `${SCOPE}:${second.id}`,
        title: "Call Alex",
        subtitle: "Work · Due today"
      }
    ]);
    expect(candidates[0].id).not.toBe(candidates[1].id);
  });

  test("picker text is bounded and free of control characters", () => {
    const noisy = task("a".repeat(24), {
      title: `Call\n\tAlex ${"x".repeat(200)}`
    });
    const [candidate] = buildTaskEntityCandidates([noisy], context);
    expect(candidate.title).not.toMatch(/[\n\t]/);
    expect(candidate.title.length).toBeLessThanOrEqual(120);
    const untitled = buildTaskEntityCandidates(
      [task("b".repeat(24), { title: "   " })],
      context
    );
    expect(untitled[0].title).toBe("Untitled");
  });

  test("the suggestion list is capped", () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      task(String(index).padStart(24, "0"))
    );
    expect(buildTaskEntityCandidates(many, context)).toHaveLength(50);
    expect(buildTaskEntityCandidates(many, context, 3)).toHaveLength(3);
  });

  test("a Task with no schedule and no List name has no invented subtitle", () => {
    expect(
      taskEntitySubtitle(
        task("a".repeat(24), { listId: "gone" }),
        undefined,
        TODAY,
        labels
      )
    ).toBe("");
  });
});

describe("what a saved Shortcut parameter completes", () => {
  test("an open Task is the Task that gets completed", () => {
    const open = task("a".repeat(24));
    expect(resolveTaskCompletionTarget(open)).toEqual({
      kind: "complete",
      id: open.id
    });
  });

  test("a completed Task is reported as already completed, not rolled onto another occurrence", () => {
    // Each occurrence has its own id. Completion binds strictly to the id the
    // caller named: rolling forward onto the series' next open occurrence
    // here would let a stale saved parameter complete a Task the person never
    // selected.
    const first = task("a".repeat(24), {
      completed: true,
      reminderDate: "2026-09-19",
      recurrenceRule: "FREQ=WEEKLY"
    });
    expect(resolveTaskCompletionTarget(first)).toEqual({
      kind: "alreadyCompleted"
    });
  });

  test("a double tap or AppIntent retry completes only once", () => {
    // The first invocation completes the picked occurrence. A retry or a
    // double tap resolves the same, now-completed Task id and must not
    // complete a second occurrence of the series.
    const picked = task("a".repeat(24), { recurrenceRule: "FREQ=WEEKLY" });
    expect(resolveTaskCompletionTarget(picked)).toEqual({
      kind: "complete",
      id: picked.id
    });
    const completed = { ...picked, completed: true };
    expect(resolveTaskCompletionTarget(completed)).toEqual({
      kind: "alreadyCompleted"
    });
  });

  test("a completed Task with nothing open is reported as already completed", () => {
    const done = task("a".repeat(24), { completed: true });
    expect(resolveTaskCompletionTarget(done)).toEqual({
      kind: "alreadyCompleted"
    });
  });
});

describe("what the picker displays for a saved Shortcut parameter", () => {
  test("an open Task is displayed with its own schedule", () => {
    const open = task("a".repeat(24), { reminderDate: "2026-09-20" });
    expect(taskEntitySubtitle(open, "Personal", TODAY, labels)).toBe(
      "Personal · Overdue"
    );
  });

  test("a completed occurrence is displayed as itself, labeled completed, never as a later occurrence of its series", () => {
    // Each occurrence has its own id, and completion binds strictly to the id
    // a Shortcut saved: "Complete Task" refuses that saved parameter once its
    // occurrence is done rather than rolling forward. The picker must not
    // show a later occurrence's schedule for it either, or tapping the
    // action on what the picker displayed would not do what it just showed.
    const first = task("a".repeat(24), {
      completed: true,
      reminderDate: "2026-09-19",
      recurrenceRule: "FREQ=WEEKLY"
    });
    expect(taskEntitySubtitle(first, "Personal", TODAY, labels)).toBe(
      "Personal · Completed"
    );
  });

  test("a completed Task with no List name is still labeled completed", () => {
    const done = task("a".repeat(24), { completed: true });
    expect(taskEntitySubtitle(done, undefined, TODAY, labels)).toBe(
      "Completed"
    );
  });
});

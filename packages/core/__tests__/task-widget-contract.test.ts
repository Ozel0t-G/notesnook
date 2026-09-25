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

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { databaseTest } from "./utils/index.js";
import { buildTaskWidgetSnapshot } from "../../../apps/mobile/app/services/task-widget-snapshot.js";

const widgetDirectory = fileURLToPath(
  new URL("../../../apps/mobile/ios/NotesWidget/", import.meta.url)
);

type DecodedSnapshot = {
  available: boolean;
  count: number;
  ids: string[];
  revisions: Record<string, number>;
};

/** Builds the production WidgetKit decoder and returns a reader that takes the
 * app's serialized snapshot through it, exactly as the extension does. */
function widgetDecoder(directory: string) {
  const binary = path.join(directory, "snapshot-contract");
  execFileSync("xcrun", [
    "swiftc",
    "-o",
    binary,
    path.join(widgetDirectory, "TaskWidgetSnapshotCodec.swift"),
    path.join(widgetDirectory, "TaskWidgetSnapshotContract.swift")
  ]);
  return (snapshot: unknown, now: number) =>
    JSON.parse(
      execFileSync(binary, [String(now / 1000)], {
        input: JSON.stringify(snapshot),
        env: {
          ...process.env,
          TZ: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      }).toString()
    ) as DecodedSnapshot;
}

function calendarDate(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

const snapshotOptions = {
  appearance: "system" as const,
  accentLight: "#123ABC",
  accentDark: "#456DEF"
};

describe("persisted Task to iOS Widget decoder", () => {
  test.skipIf(process.platform !== "darwin")(
    "scheduled Task appears and completed Task leaves the serialized Widget rows",
    async () => {
      const temporaryDirectory = mkdtempSync(
        path.join(tmpdir(), "task-widget-db-")
      );
      try {
        const decode = widgetDecoder(temporaryDirectory);
        const db = await databaseTest();
        const now = new Date(2026, 8, 24, 12).getTime();
        const today = calendarDate(now);
        const task = await db.tasks.create({
          title: "Widget Regression Test",
          reminderDate: today,
          reminderTime: "14:00"
        });
        const read = async () =>
          decode(
            buildTaskWidgetSnapshot(await db.tasks.list(), {
              ...snapshotOptions,
              now
            }),
            now
          );
        expect(await read()).toMatchObject({
          available: true,
          ids: [task.id]
        });
        await db.tasks.complete(task.id);
        expect(await read()).toMatchObject({ available: true, ids: [] });
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  );

  // What the iOS 27 widget completion intent does end to end: it validates the
  // revision it read from the snapshot, calls this exact domain operation, and
  // then writes the snapshot again from the persisted Tasks.
  test.skipIf(process.platform !== "darwin")(
    "a widget completion of a recurring Task persists the next occurrence and survives a retry",
    async () => {
      const temporaryDirectory = mkdtempSync(
        path.join(tmpdir(), "task-widget-recurring-")
      );
      try {
        const decode = widgetDecoder(temporaryDirectory);
        const db = await databaseTest();
        // Recurrence advances from the wall date the completion is recorded on,
        // so this case has to run on the real calendar day.
        const now = Date.now();
        const today = calendarDate(now);
        const task = await db.tasks.create({
          title: "Water the plants",
          reminderDate: today,
          reminderTime: "09:00",
          recurrenceRule: "FREQ=DAILY"
        });
        const read = async (at: number) =>
          decode(
            buildTaskWidgetSnapshot(await db.tasks.list(), {
              ...snapshotOptions,
              now: at,
              accountScope: "0123456789abcdef0123456789abcdef"
            }),
            at
          );

        // The widget button carries the revision it can see. The host refuses
        // the action unless the persisted Task still matches it.
        const visible = await read(now);
        expect(visible.ids).toEqual([task.id]);
        expect(visible.revisions[task.id]).toBe(task.updatedAt);

        await db.tasks.complete(task.id);
        const active = (await db.tasks.list()).filter(
          (item) => !item.completed
        );
        expect(active).toHaveLength(1);
        const next = active[0];
        expect(next.id).not.toBe(task.id);
        expect(next.seriesId).toBe(task.id);
        const nextDueDate = next.dueDate ?? "";
        expect(nextDueDate > today).toBe(true);
        const nextDay = new Date(`${nextDueDate}T12:00:00`).getTime();

        // Today's row is gone and the next occurrence takes its place, so the
        // widget cannot show a completed occurrence as outstanding.
        expect((await read(now)).ids).toEqual([]);
        expect((await read(nextDay)).ids).toEqual([next.id]);

        // A repeat tap, a retry of the durable action and a resumed crash all
        // replay this call. The occurrence id is derived from the series and the
        // occurrence, so replaying cannot fork the series or double-advance it.
        await db.tasks.complete(task.id);
        await db.tasks.complete(task.id);
        const afterRetry = (await db.tasks.list()).filter(
          (item) => !item.completed
        );
        expect(afterRetry.map((item) => item.id)).toEqual([next.id]);
        expect((await read(nextDay)).ids).toEqual([next.id]);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  );
});

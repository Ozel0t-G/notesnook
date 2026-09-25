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

describe("persisted Task to iOS Widget decoder", () => {
  test.skipIf(process.platform !== "darwin")(
    "scheduled Task appears and completed Task leaves the serialized Widget rows",
    async () => {
      const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "task-widget-db-"));
      const binary = path.join(temporaryDirectory, "snapshot-contract");
      try {
        execFileSync("xcrun", [
          "swiftc", "-o", binary,
          path.join(widgetDirectory, "TaskWidgetSnapshotCodec.swift"),
          path.join(widgetDirectory, "TaskWidgetSnapshotContract.swift")
        ]);
        const db = await databaseTest();
        const now = new Date(2026, 8, 24, 12).getTime();
        const date = new Date(now);
        const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const task = await db.tasks.create({
          title: "Widget Regression Test",
          reminderDate: today,
          reminderTime: "14:00"
        });
        const options = {
          now, appearance: "system" as const,
          accentLight: "#123ABC", accentDark: "#456DEF"
        };
        const decode = async () => {
          const snapshot = buildTaskWidgetSnapshot(await db.tasks.list(), options);
          return JSON.parse(execFileSync(binary, [String(now / 1000)], {
            input: JSON.stringify(snapshot),
            env: {
              ...process.env,
              TZ: Intl.DateTimeFormat().resolvedOptions().timeZone
            }
          }).toString()) as { available: boolean; ids: string[] };
        };
        expect(await decode()).toMatchObject({
          available: true, ids: [task.id]
        });
        await db.tasks.complete(task.id);
        expect(await decode()).toMatchObject({ available: true, ids: [] });
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  );
});

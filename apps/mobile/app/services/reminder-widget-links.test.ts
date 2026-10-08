/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

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

import {
  parseReminderWidgetLink,
  REMINDER_WIDGET_URLS
} from "./reminder-widget-links";

// A valid 24-hex Task id and the widget's opaque 32-hex account scope.
const ID = "a".repeat(24);
const OTHER_ID = "0123456789abcdef01234567";
const SCOPE = "b".repeat(32);

describe("widget link parsing", () => {
  test("resolves the plain list and create destinations", () => {
    expect(parseReminderWidgetLink("ShareMedia://TasksWidget")).toEqual({
      action: "list"
    });
    expect(parseReminderWidgetLink("veyran://tasks")).toEqual({
      action: "list"
    });
    expect(parseReminderWidgetLink("ShareMedia://NewTaskWidget")).toEqual({
      action: "create"
    });
    expect(parseReminderWidgetLink("veyran://task/new")).toEqual({
      action: "create"
    });
  });

  test("reads a Task link with no identity as an accountless open", () => {
    expect(
      parseReminderWidgetLink(`ShareMedia://TaskWidget?id=${ID}`)
    ).toEqual({ action: "task", id: ID });
    expect(parseReminderWidgetLink(`veyran://task/${ID}`)).toEqual({
      action: "task",
      id: ID
    });
  });

  test("carries a fully-specified identity", () => {
    expect(
      parseReminderWidgetLink(
        `ShareMedia://TaskWidget?id=${ID}&scope=${SCOPE}&updatedAt=42&occurrenceKey=2026-10-01T14:00`
      )
    ).toEqual({
      action: "task",
      id: ID,
      scope: SCOPE,
      updatedAt: 42,
      occurrenceKey: "2026-10-01T14:00"
    });
  });

  test("carries the full identity on the app's own general open URL", () => {
    expect(
      parseReminderWidgetLink(
        `veyran://task/${ID}?action=open&scope=${SCOPE}&updatedAt=42&occurrenceKey=2026-10-01T14:00&seriesId=${OTHER_ID}`
      )
    ).toEqual({
      action: "task",
      id: ID,
      scope: SCOPE,
      updatedAt: 42,
      occurrenceKey: "2026-10-01T14:00",
      seriesId: OTHER_ID
    });
    // The home-widget row carries no occurrence identity: an explicit open with
    // no scope still resolves, still accountlessly.
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=open`)
    ).toEqual({ action: "task", id: ID });
  });

  test("refuses an unknown action or a malformed identity on a veyran link", () => {
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=delete`)
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=`)
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?scope=nothex`)
    ).toBeUndefined();
    expect(parseReminderWidgetLink(`veyran://task/${ID}?scope=`)).toBeUndefined();
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=open&action=open`)
    ).toBeUndefined();
  });

  test("carries the full identity on the app's own reschedule URL", () => {
    expect(
      parseReminderWidgetLink(
        `veyran://task/${ID}?action=reschedule&scope=${SCOPE}&updatedAt=42&occurrenceKey=2026-10-01T14:00&seriesId=${OTHER_ID}`
      )
    ).toEqual({
      action: "reschedule",
      id: ID,
      scope: SCOPE,
      updatedAt: 42,
      occurrenceKey: "2026-10-01T14:00",
      seriesId: OTHER_ID
    });
    // The emitted link uses this app's own scheme -- never the shared
    // ShareMedia scheme iOS may route to the upstream Notesnook app -- and
    // round-trips through the same strict parser.
    const emitted = REMINDER_WIDGET_URLS.reschedule(ID);
    expect(emitted.startsWith("veyran://task/")).toBe(true);
    expect(emitted).not.toContain("ShareMedia");
    expect(parseReminderWidgetLink(emitted)).toEqual({
      action: "reschedule",
      id: ID
    });
  });

  test("keeps the app's own reschedule link as strict as its open link", () => {
    expect(
      parseReminderWidgetLink(
        `veyran://task/${ID}?action=reschedule&scope=nothex`
      )
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=reschedule&scope=`)
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(
        `veyran://task/${ID}?action=reschedule&action=reschedule`
      )
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(`veyran://task/${ID}?action=reschedule#fragment`)
    ).toBeUndefined();
  });

  test("carries the occurrence's series on a reschedule link", () => {
    expect(
      parseReminderWidgetLink(
        `ShareMedia://RescheduleTaskWidget?id=${ID}&scope=${SCOPE}&updatedAt=42&occurrenceKey=2026-10-01T14:00&seriesId=${ID}`
      )
    ).toEqual({
      action: "reschedule",
      id: ID,
      scope: SCOPE,
      updatedAt: 42,
      occurrenceKey: "2026-10-01T14:00",
      seriesId: ID
    });
    expect(
      parseReminderWidgetLink(
        `ShareMedia://RescheduleTaskWidget?id=${ID}&occurrenceKey=2026-10-01Tdate&seriesId=${OTHER_ID}`
      )
    ).toEqual({
      action: "reschedule",
      id: ID,
      occurrenceKey: "2026-10-01Tdate",
      seriesId: OTHER_ID
    });
  });

  test("distinguishes the reschedule and complete actions", () => {
    expect(
      parseReminderWidgetLink(`ShareMedia://RescheduleTaskWidget?id=${OTHER_ID}`)
    ).toEqual({ action: "reschedule", id: OTHER_ID });
    expect(
      parseReminderWidgetLink(`ShareMedia://CompleteTaskWidget?id=${OTHER_ID}`)
    ).toEqual({ action: "complete", id: OTHER_ID });
  });

  test("rejects a present but empty identity value instead of ignoring it", () => {
    for (const query of ["scope=", "updatedAt=", "occurrenceKey=", "seriesId="]) {
      expect(
        parseReminderWidgetLink(`ShareMedia://TaskWidget?id=${ID}&${query}`)
      ).toBeUndefined();
    }
  });

  test("rejects malformed identity values", () => {
    expect(
      parseReminderWidgetLink(`ShareMedia://TaskWidget?id=${ID}&scope=nothex`)
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(
        `ShareMedia://TaskWidget?id=${ID}&scope=${"b".repeat(31)}`
      )
    ).toBeUndefined();
    for (const updatedAt of ["0", "-1", "1.5", "abc"]) {
      expect(
        parseReminderWidgetLink(
          `ShareMedia://TaskWidget?id=${ID}&updatedAt=${updatedAt}`
        )
      ).toBeUndefined();
    }
    expect(
      parseReminderWidgetLink(
        `ShareMedia://TaskWidget?id=${ID}&occurrenceKey=${"x".repeat(65)}`
      )
    ).toBeUndefined();
  });

  test("rejects duplicate parameters rather than reading the first", () => {
    expect(
      parseReminderWidgetLink(
        `ShareMedia://TaskWidget?id=${ID}&id=${OTHER_ID}`
      )
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(
        `ShareMedia://TaskWidget?id=${ID}&scope=${SCOPE}&scope=${SCOPE}`
      )
    ).toBeUndefined();
  });

  test("rejects an extra path segment or a fragment", () => {
    expect(
      parseReminderWidgetLink(`ShareMedia://TaskWidget/extra?id=${ID}`)
    ).toBeUndefined();
    expect(
      parseReminderWidgetLink(`ShareMedia://TaskWidget?id=${ID}#fragment`)
    ).toBeUndefined();
  });

  test("rejects an unparseable Task id and an unknown host", () => {
    expect(parseReminderWidgetLink("ShareMedia://TaskWidget?id=zz")).toBeUndefined();
    expect(parseReminderWidgetLink("ShareMedia://OtherWidget?id=")).toBeUndefined();
    expect(parseReminderWidgetLink(null)).toBeUndefined();
    expect(parseReminderWidgetLink("")).toBeUndefined();
  });
});

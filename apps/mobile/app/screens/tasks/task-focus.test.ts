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

import {
  resolveTaskFocusIndex,
  TASK_FOCUS_DEADLINE_MS,
  TASK_FOCUS_MAX_SCROLL_RETRIES,
  TASK_HIGHLIGHT_DURATION_MS,
  TaskFocusSession,
  type TaskFocusDriver
} from "./task-focus";

function createDriver() {
  const calls = {
    scroll: [] as Array<[number, boolean]>,
    reset: [] as Array<[number, number]>,
    start: [] as string[],
    end: [] as string[],
    unresolved: [] as string[]
  };
  const driver: TaskFocusDriver = {
    requestScroll: (index, animated) => calls.scroll.push([index, animated]),
    resetScroll: (index, averageItemLength) =>
      calls.reset.push([index, averageItemLength]),
    startHighlight: (id) => calls.start.push(id),
    endHighlight: (id) => calls.end.push(id),
    onUnresolved: (id) => calls.unresolved.push(id)
  };
  return { driver, calls };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("resolveTaskFocusIndex", () => {
  test("finds the row or reports it is not in the current list", () => {
    const tasks = [{ id: "a" }, { id: "b" }];
    expect(resolveTaskFocusIndex(tasks, "b")).toBe(1);
    expect(resolveTaskFocusIndex(tasks, "missing")).toBe(-1);
    expect(resolveTaskFocusIndex(tasks, undefined)).toBe(-1);
    expect(resolveTaskFocusIndex([], "a")).toBe(-1);
  });
});

describe("TaskFocusSession", () => {
  test("scrolls immediately but only highlights once the row is actually viewable", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "1" }, 3);
    expect(calls.scroll).toEqual([[3, true]]);
    expect(calls.start).toEqual([]);

    session.watchViewable(["x", "a"]);
    expect(calls.start).toEqual(["a"]);

    jest.advanceTimersByTime(TASK_HIGHLIGHT_DURATION_MS);
    expect(calls.end).toEqual(["a"]);
    expect(calls.unresolved).toEqual([]);
  });

  test("gives up within a bounded deadline when the row never becomes viewable", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "2" }, 0);
    session.watchViewable(["b"]);
    expect(calls.start).toEqual([]);

    jest.advanceTimersByTime(TASK_FOCUS_DEADLINE_MS);
    expect(calls.unresolved).toEqual(["a"]);
    expect(calls.end).toEqual([]);
  });

  test("never re-arms the highlight from mere visibility after it ended", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "3" }, 0);
    session.watchViewable(["a"]);
    jest.advanceTimersByTime(TASK_HIGHLIGHT_DURATION_MS);
    expect(calls.start).toEqual(["a"]);

    session.watchViewable(["a"]);
    expect(calls.start).toEqual(["a"]);
  });

  test("retries are bounded, then the focus is released", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "4" }, 2);
    for (let attempt = 0; attempt < TASK_FOCUS_MAX_SCROLL_RETRIES; attempt++) {
      session.onScrollToIndexFailed(2, 50);
      jest.advanceTimersByTime(80 * (attempt + 1));
    }
    // One initial scroll plus one per retry, and still no stuck highlight.
    expect(calls.scroll).toHaveLength(1 + TASK_FOCUS_MAX_SCROLL_RETRIES);
    expect(calls.start).toEqual([]);

    session.onScrollToIndexFailed(2, 50);
    expect(calls.unresolved).toEqual(["a"]);
  });

  test("cancel aborts pending retries and ends a running highlight", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "5" }, 0);
    session.watchViewable(["a"]);
    session.cancel();

    expect(calls.end).toEqual(["a"]);
    session.onScrollToIndexFailed(0, 50);
    jest.advanceTimersByTime(TASK_FOCUS_DEADLINE_MS);
    expect(calls.start).toEqual(["a"]);
    expect(calls.unresolved).toEqual([]);
  });

  test("a new request aborts the old one so no late scroll targets the old index", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "6a" }, 1);
    session.onScrollToIndexFailed(1, 40);
    session.begin({ taskId: "b", requestId: "6b" }, 5);

    jest.advanceTimersByTime(1000);

    expect(calls.scroll).toEqual([
      [1, true],
      [5, true]
    ]);
  });

  test("adopts an index that only becomes resolvable after the request was armed", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "7" }, -1);
    expect(calls.scroll).toEqual([]);

    session.begin({ taskId: "a", requestId: "7" }, 4);
    expect(calls.scroll).toEqual([[4, true]]);

    session.watchViewable(["a"]);
    expect(calls.start).toEqual(["a"]);
  });

  test("ignores a redelivery of a request that already ran its course", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "8" }, 0);
    session.watchViewable(["a"]);
    jest.advanceTimersByTime(TASK_HIGHLIGHT_DURATION_MS);
    expect(calls.end).toEqual(["a"]);

    calls.scroll.length = 0;
    session.begin({ taskId: "a", requestId: "8" }, 0);
    expect(calls.scroll).toEqual([]);
    expect(calls.start).toEqual(["a"]);
  });

  test("keeps an unresolvable request armed until the bounded deadline", () => {
    const { driver, calls } = createDriver();
    const session = new TaskFocusSession(driver);

    session.begin({ taskId: "a", requestId: "9" }, -1);
    expect(calls.unresolved).toEqual([]);

    jest.advanceTimersByTime(TASK_FOCUS_DEADLINE_MS);
    expect(calls.unresolved).toEqual(["a"]);
  });
});

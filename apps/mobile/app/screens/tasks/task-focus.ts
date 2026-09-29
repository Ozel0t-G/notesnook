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
 * Scrolls a targeted Task row into view in the virtualized Tasks list and
 * briefly highlights it once it is actually visible -- never before.
 *
 * The behavior is deliberately bounded:
 * - the highlight only starts from a real FlatList viewability callback, never
 *   from a fixed delay or from the mere existence of a request;
 * - retries are capped and driven by `onScrollToIndexFailed`;
 * - a bounded deadline gives up on a target that never becomes visible;
 * - a new focus request (a fresh nonce) or `cancel()` (unmount) aborts every
 *   pending timer and any running highlight, so an old target is never scrolled
 *   or highlighted after a newer tap.
 */

export const TASK_FOCUS_VIEW_POSITION = 0.4;
export const TASK_FOCUS_MAX_SCROLL_RETRIES = 5;
/** A bounded deadline for the target to become viewable before giving up. */
export const TASK_FOCUS_DEADLINE_MS = 2000;
export const TASK_HIGHLIGHT_DURATION_MS = 2200;
const TASK_FOCUS_RETRY_BASE_MS = 80;

export type TaskFocusRequest = {
  taskId: string;
  /** Unique per request, so re-focusing the same Task re-arms the focus. */
  requestId: string;
};

export type TaskFocusDriver = {
  /** Scroll the row at `index` into view at `viewPosition`. */
  requestScroll(index: number, animated: boolean): void;
  /** Jump to an approximate offset so a retry can measure the target row. */
  resetScroll(index: number, averageItemLength: number): void;
  startHighlight(taskId: string): void;
  endHighlight(taskId: string): void;
  /** The request could not be satisfied; stop holding a highlight for it. */
  onUnresolved(taskId: string): void;
};

export type TaskFocusScheduler = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const defaultTaskFocusScheduler: TaskFocusScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** The index of the row to focus, or -1 when it is not in the current list. */
export function resolveTaskFocusIndex(
  tasks: ReadonlyArray<{ id: string }>,
  taskId: string | null | undefined
): number {
  if (!taskId) return -1;
  return tasks.findIndex((task) => task.id === taskId);
}

export class TaskFocusSession {
  private request: TaskFocusRequest | undefined;
  private index = -1;
  private attempts = 0;
  private highlighted: string | undefined;
  /** The last request that ran to completion, so redelivery is a no-op. */
  private settledRequestId: string | undefined;
  private deadline: unknown;
  private timers: unknown[] = [];

  constructor(
    private readonly driver: TaskFocusDriver,
    private readonly scheduler: TaskFocusScheduler = defaultTaskFocusScheduler
  ) {}

  /**
   * Arm (or re-arm) focus for a request. A redelivery of the same, already
   * settled request is ignored so a routine list refresh cannot re-highlight;
   * a redelivery of an in-flight request adopts a now-resolvable index without
   * restarting a running highlight.
   */
  begin(request: TaskFocusRequest, index: number): void {
    if (request.requestId === this.settledRequestId) return;
    if (this.request?.requestId === request.requestId) {
      if (index >= 0 && this.index < 0) {
        // The list data arrived after the request was first armed; adopt the
        // now-resolvable index without restarting anything.
        this.index = index;
        this.attempts = 0;
        this.attemptScroll();
      }
      return;
    }
    this.reset();
    this.request = request;
    this.index = index;
    this.attempts = 0;
    // Stay armed even when the row is not in the current list yet: the list may
    // still be loading. The bounded deadline below releases a target that never
    // becomes resolvable, so nothing is left hanging.
    this.scheduleDeadline();
    this.attemptScroll();
  }

  /** Feed the current set of visible row ids from FlatList. */
  watchViewable(viewableTaskIds: ReadonlyArray<string>): void {
    const request = this.request;
    if (!request || this.highlighted) return;
    if (!viewableTaskIds.includes(request.taskId)) return;
    this.clearDeadline();
    this.highlighted = request.taskId;
    this.driver.startHighlight(request.taskId);
    this.timers.push(
      this.scheduler.set(() => {
        if (this.highlighted !== request.taskId) return;
        this.highlighted = undefined;
        this.settledRequestId = request.requestId;
        this.request = undefined;
        this.driver.endHighlight(request.taskId);
      }, TASK_HIGHLIGHT_DURATION_MS)
    );
  }

  /** FlatList could not measure the target yet; retry within the cap. */
  onScrollToIndexFailed(_index: number, averageItemLength: number): void {
    if (!this.request || this.index < 0 || this.highlighted) return;
    if (this.attempts >= TASK_FOCUS_MAX_SCROLL_RETRIES) {
      this.unresolved();
      return;
    }
    this.attempts += 1;
    this.driver.resetScroll(this.index, averageItemLength);
    const request = this.request;
    this.timers.push(
      this.scheduler.set(() => {
        if (this.request !== request || this.highlighted) return;
        this.attemptScroll();
      }, TASK_FOCUS_RETRY_BASE_MS * this.attempts)
    );
  }

  /** Abort everything: a new intent, a list change, or unmount. */
  cancel(): void {
    this.reset();
  }

  private attemptScroll(): void {
    if (!this.request || this.index < 0) return;
    this.driver.requestScroll(this.index, true);
  }

  private scheduleDeadline(): void {
    const request = this.request;
    this.deadline = this.scheduler.set(() => {
      if (!request || this.request !== request || this.highlighted) return;
      this.unresolved();
    }, TASK_FOCUS_DEADLINE_MS);
  }

  private clearDeadline(): void {
    if (this.deadline === undefined) return;
    this.scheduler.clear(this.deadline);
    this.deadline = undefined;
  }

  private unresolved(): void {
    const request = this.request;
    this.clearTimers();
    if (this.highlighted) {
      this.driver.endHighlight(this.highlighted);
      this.highlighted = undefined;
    }
    this.request = undefined;
    this.index = -1;
    this.attempts = 0;
    if (request) {
      this.settledRequestId = request.requestId;
      this.driver.onUnresolved(request.taskId);
    }
  }

  private clearTimers(): void {
    this.clearDeadline();
    for (const timer of this.timers) this.scheduler.clear(timer);
    this.timers = [];
  }

  private reset(): void {
    this.clearTimers();
    if (this.highlighted) {
      this.driver.endHighlight(this.highlighted);
      this.highlighted = undefined;
    }
    this.request = undefined;
    this.index = -1;
    this.attempts = 0;
  }
}

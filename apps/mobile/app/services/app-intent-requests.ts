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

import { db } from "../common/database";
import { textToHTML } from "./notifications";
import { TaskNotifications } from "./task-notifications";
import Navigation from "./navigation";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";

export type AppIntentRequest = {
  id: string;
  action: "createTask" | "completeTask" | "createNote" | "todayTasks";
  payload: Record<string, string>;
};

export type AppIntentReply = { status: string; value: string };

const repeatRules: Record<string, string | undefined> = {
  never: undefined,
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY"
};

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(value.getDate()).padStart(2, "0")}`;
}

function localTime(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(
    value.getMinutes()
  ).padStart(2, "0")}`;
}

function failure(status: string): AppIntentReply {
  return { status, value: "" };
}

export async function executeAppIntentRequest(
  request: AppIntentRequest
): Promise<AppIntentReply> {
  if (useUserStore.getState().appLocked || useUserStore.getState().isLoggingOut)
    return failure("locked");
  if (!db.isInitialized) return failure("unavailable");

  try {
    const payload = request.payload;
    switch (request.action) {
      case "createTask": {
        const title = payload.title?.trim();
        if (!title) return failure("invalid");
        let listId = (await db.taskLists.default()).id;
        if (payload.listName?.trim()) {
          const matches = (await db.taskLists.list()).filter(
            (list) =>
              list.name.toLocaleLowerCase() ===
              payload.listName.trim().toLocaleLowerCase()
          );
          if (!matches.length) return failure("notFound");
          if (matches.length !== 1) return failure("ambiguous");
          listId = matches[0].id;
        }
        const priority = payload.priority || "none";
        if (!["none", "low", "medium", "high"].includes(priority))
          return failure("invalid");
        const repeatMode = payload.repeatMode || "never";
        if (!(repeatMode in repeatRules)) return failure("invalid");
        const reminderTimestamp = payload.reminderTimestamp
          ? Number(payload.reminderTimestamp)
          : undefined;
        if (
          reminderTimestamp !== undefined &&
          (!Number.isFinite(reminderTimestamp) ||
            Number.isNaN(new Date(reminderTimestamp).getTime()))
        )
          return failure("invalid");
        const reminder =
          reminderTimestamp === undefined
            ? undefined
            : new Date(reminderTimestamp);
        if (repeatMode !== "never" && !reminder) return failure("invalid");
        const urgent = payload.urgent === "true";
        if (urgent && !reminder) return failure("invalid");
        if (urgent) {
          const status = await TaskNotifications.urgentStatus();
          const authorized =
            status === "authorized"
              ? status
              : await TaskNotifications.requestUrgentPermission();
          if (authorized !== "authorized") return failure("unavailable");
        } else if (reminder) {
          await TaskNotifications.requestPermission().catch(() => false);
        }
        const task = await db.tasks.create({
          title,
          listId,
          reminderDate: reminder ? localDate(reminder) : undefined,
          reminderTime: reminder ? localTime(reminder) : undefined,
          recurrenceRule: repeatRules[repeatMode],
          priority: priority as "none" | "low" | "medium" | "high",
          flagged: payload.flagged === "true",
          urgent
        });
        return { status: "ok", value: task.id };
      }
      case "completeTask": {
        const title = payload.title?.trim();
        if (!title) return failure("invalid");
        const matches = (await db.tasks.list()).filter(
          (task) =>
            !task.completed &&
            task.title.toLocaleLowerCase() === title.toLocaleLowerCase()
        );
        if (!matches.length) return failure("notFound");
        if (matches.length !== 1) return failure("ambiguous");
        await db.tasks.complete(matches[0].id);
        return { status: "ok", value: matches[0].id };
      }
      case "createNote": {
        const title = payload.title?.trim();
        const content = payload.content?.trim();
        if (!title && !content) return failure("invalid");
        const id = await db.notes.add({
          ...(title ? { title } : {}),
          ...(content
            ? {
                content: { type: "tiptap" as const, data: textToHTML(content) }
              }
            : {})
        });
        // The Note is already saved. A failed optional default association
        // must not make Shortcuts report a failed save and invite a duplicate.
        try {
          const defaultNotebook = db.settings.getDefaultNotebook();
          if (defaultNotebook)
            await db.notes.addToNotebook(defaultNotebook, id);
          const defaultTag = db.settings.getDefaultTag();
          if (defaultTag) {
            const tag = await db.tags.tag(defaultTag);
            const note = await db.notes.note(id);
            if (tag && note) await db.relations.add(tag, note);
          }
        } catch {
          // Keep the successful Note creation as the acknowledged result.
        }
        Navigation.queueRoutesForUpdate("Notes");
        return { status: "ok", value: id };
      }
      case "todayTasks": {
        // Shortcut output lives outside the app. App Lock therefore blocks
        // exporting Task titles even when the current UI was just unlocked.
        if (useSettingStore.getState().settings.appLockEnabled)
          return failure("locked");
        const titles = (await db.tasks.smartList("today"))
          .slice(0, 50)
          .map((task) => task.title);
        return { status: "ok", value: JSON.stringify(titles) };
      }
      default:
        return failure("invalid");
    }
  } catch {
    return failure("failed");
  }
}

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

import { Box, Button, Flex, Text } from "@theme-ui/components";
import { useState } from "react";
import Dialog from "../components/dialog";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import {
  TaskInput,
  TaskListRecord,
  TaskPriority,
  TaskRecord,
  taskDomain
} from "../common/task-domain";
import { ConfirmDialog } from "./confirm";
import { showToast } from "../utils/toast";
import { logger } from "../utils/logger";
import { strings } from "@notesnook/intl";
import { TaskListGlyph } from "../components/task-list-appearance";
import { taskReminderSchedule } from "@notesnook/core";
import { isMac } from "../utils/platform";
import "../styles/veyran-mac-tasks.css";

type TaskDialogProps = BaseDialogProps<boolean> & {
  task?: TaskRecord;
  lists: TaskListRecord[];
  defaultListId?: string;
};

const presetRules = {
  none: "",
  daily: "FREQ=DAILY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekends: "FREQ=WEEKLY;BYDAY=SA,SU",
  weekly: "FREQ=WEEKLY",
  biweekly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  quarterly: "FREQ=MONTHLY;INTERVAL=3",
  halfyearly: "FREQ=MONTHLY;INTERVAL=6",
  yearly: "FREQ=YEARLY"
} as const;
type RepeatPreset = keyof typeof presetRules | "custom";
type CustomFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
function buildCustomRule(
  frequency: CustomFrequency,
  interval: number,
  days: string[]
) {
  const value = Math.max(1, Math.min(365, Math.floor(interval || 1)));
  return `FREQ=${frequency};INTERVAL=${value}${
    frequency === "WEEKLY" && days.length ? `;BYDAY=${days.join(",")}` : ""
  }`;
}

function presetForRule(rule?: string): RepeatPreset {
  if (!rule) return "none";
  const match = Object.entries(presetRules).find(([, value]) => value === rule);
  return (match?.[0] as RepeatPreset | undefined) || "custom";
}

function scheduleForTask(task?: TaskRecord) {
  if (!task) return { date: "", time: "" };
  const schedule = taskReminderSchedule(task);
  return { date: schedule.date || "", time: schedule.time || "" };
}

const controlStyle = {
  display: "block",
  width: "100%",
  boxSizing: "border-box" as const,
  minHeight: 36,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "7px 10px",
  color: "var(--paragraph)",
  background: "var(--background)",
  font: "inherit"
};

export const TaskDialog = DialogManager.register(function TaskDialog(
  props: TaskDialogProps
) {
  const { task, lists } = props;
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [listId, setListId] = useState(
    task?.listId || props.defaultListId || lists[0]?.id || ""
  );
  const [reminderDate, setReminderDate] = useState(scheduleForTask(task).date);
  const [reminderTime, setReminderTime] = useState(scheduleForTask(task).time);
  const [priority, setPriority] = useState<TaskPriority>(
    task?.priority || "none"
  );
  const [flagged, setFlagged] = useState(task?.flagged || false);
  const [urgent, setUrgent] = useState(Boolean(task?.urgent));
  const [repeatPreset, setRepeatPreset] = useState<RepeatPreset>(
    presetForRule(task?.recurrenceRule)
  );
  const [customFrequency, setCustomFrequency] = useState<CustomFrequency>(
    (/(?:^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(
      task?.recurrenceRule || ""
    )?.[1] as CustomFrequency) || "WEEKLY"
  );
  const [customInterval, setCustomInterval] = useState(
    Number(/(?:^|;)INTERVAL=(\d+)/.exec(task?.recurrenceRule || "")?.[1] || 1)
  );
  const [customDays, setCustomDays] = useState<string[]>(
    /(?:^|;)BYDAY=([A-Z,]+)/
      .exec(task?.recurrenceRule || "")?.[1]
      ?.split(",") || []
  );
  const [customDirty, setCustomDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim() || !listId || saving) return;
    const recurrenceRule =
      repeatPreset === "custom"
        ? !customDirty &&
          task?.recurrenceRule &&
          presetForRule(task.recurrenceRule) === "custom"
          ? task.recurrenceRule
          : buildCustomRule(customFrequency, customInterval, customDays)
        : presetRules[repeatPreset];
    if (repeatPreset === "custom" && !recurrenceRule) {
      showToast("error", strings.tasksInvalidRecurrence());
      return;
    }
    if (recurrenceRule && !reminderDate) {
      showToast("error", strings.tasksRepeatNeedsReminderDate());
      return;
    }

    const input: TaskInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      listId,
      reminderDate: reminderDate || undefined,
      reminderTime: reminderDate && reminderTime ? reminderTime : undefined,
      urgent: Boolean(reminderDate && reminderTime && urgent),
      recurrenceRule: recurrenceRule || undefined,
      priority,
      flagged
    } as TaskInput;

    setSaving(true);
    try {
      if (task) await taskDomain.tasks.update(task.id, input);
      else await taskDomain.tasks.create(input);
      props.onClose(true);
    } catch (error) {
      logger.error(error);
      showToast("error", strings.tasksCouldNotSave());
      setSaving(false);
    }
  }

  async function toggleCompletion() {
    if (!task) return;
    try {
      if (task.completed) await taskDomain.tasks.uncomplete(task.id);
      else await taskDomain.tasks.complete(task.id);
      props.onClose(true);
    } catch (error) {
      logger.error(error);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  async function remove() {
    if (!task) return;
    const confirmed = await ConfirmDialog.show({
      title: strings.tasksDelete(),
      message: task.title,
      positiveButtonText: strings.tasksDelete(),
      negativeButtonText: strings.cancel()
    });
    if (!confirmed) return;
    try {
      await taskDomain.tasks.remove(task.id);
      props.onClose(true);
    } catch (error) {
      logger.error(error);
      showToast("error", strings.tasksCouldNotSave());
    }
  }

  return (
    <Dialog
      isOpen
      width={540}
      title={task ? strings.tasksEditTask() : strings.tasksAddTask()}
      testId="task-dialog"
      onClose={() => props.onClose(false)}
      positiveButton={{
        text: task ? strings.tasksSave() : strings.tasksAddTask(),
        disabled: !title.trim() || !listId || saving,
        onClick: save
      }}
      negativeButton={{
        text: strings.cancel(),
        onClick: () => props.onClose(false)
      }}
    >
      <Flex
        className={
          IS_DESKTOP_APP && isMac() ? "veyran-mac-task-dialog" : undefined
        }
        sx={{ flexDirection: "column", gap: 3 }}
      >
        <TaskControl label={strings.tasksTaskTitle()}>
          <input
            autoFocus
            aria-label={strings.tasksTaskTitle()}
            data-test-id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
            style={controlStyle}
          />
        </TaskControl>
        <TaskControl label={strings.description()}>
          <textarea
            aria-label={strings.description()}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            style={{ ...controlStyle, resize: "vertical" }}
          />
        </TaskControl>
        {task?.legacyReminderId && (
          <Text variant="subBody" sx={{ color: "paragraph-muted" }}>
            {strings.tasksLegacyMigrationNotice()}
          </Text>
        )}
        <TaskControl label={strings.tasksList()}>
          <Flex sx={{ alignItems: "center", gap: 2 }}>
            <TaskListGlyph
              symbol={lists.find((list) => list.id === listId)?.symbol}
              color={lists.find((list) => list.id === listId)?.color}
              size={22}
            />
            <select
              aria-label={strings.tasksList()}
              value={listId}
              onChange={(event) => setListId(event.target.value)}
              style={controlStyle}
            >
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </Flex>
        </TaskControl>
        <Text sx={{ fontWeight: "bold" }}>{strings.tasksReminder()}</Text>
        <Flex sx={{ gap: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 180px" }}>
            <TaskControl label={strings.tasksDate()}>
              <input
                type="date"
                aria-label={`${strings.tasksReminder()} ${strings.tasksDate()}`}
                value={reminderDate}
                onChange={(event) => {
                  setReminderDate(event.target.value);
                  if (!event.target.value) setReminderTime("");
                }}
                style={controlStyle}
              />
            </TaskControl>
          </Box>
          <Box sx={{ flex: "1 1 140px" }}>
            <TaskControl label={strings.tasksTime()}>
              <input
                type="time"
                aria-label={`${strings.tasksReminder()} ${strings.tasksTime()}`}
                disabled={!reminderDate}
                value={reminderTime}
                onChange={(event) => setReminderTime(event.target.value)}
                style={controlStyle}
              />
            </TaskControl>
          </Box>
        </Flex>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: urgent ? 1 : 0.65
          }}
        >
          <input
            type="checkbox"
            disabled={!urgent}
            checked={urgent}
            onChange={() => setUrgent(false)}
          />
          <Text>{strings.tasksUrgent()}</Text>
        </label>
        <Text variant="subBody" sx={{ color: "paragraph-muted" }}>
          {strings.tasksUrgentMacUnavailable()}
        </Text>
        <TaskControl label={strings.tasksRepeat()}>
          <select
            aria-label={strings.tasksRepeat()}
            value={repeatPreset}
            onChange={(event) =>
              setRepeatPreset(event.target.value as RepeatPreset)
            }
            style={controlStyle}
          >
            <option value="none">{strings.tasksNone()}</option>
            <option value="daily">{strings.tasksDaily()}</option>
            <option value="weekdays">{strings.tasksWeekdays()}</option>
            <option value="weekends">{strings.tasksWeekends()}</option>
            <option value="weekly">{strings.tasksWeekly()}</option>
            <option value="biweekly">{strings.tasksBiweekly()}</option>
            <option value="monthly">{strings.tasksMonthly()}</option>
            <option value="quarterly">{strings.tasksEveryThreeMonths()}</option>
            <option value="halfyearly">{strings.tasksEverySixMonths()}</option>
            <option value="yearly">{strings.tasksYearly()}</option>
            <option value="custom">{strings.tasksCustom()}</option>
          </select>
        </TaskControl>
        {repeatPreset === "custom" ? (
          <TaskControl label={strings.tasksCustom()}>
            <Flex sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Text>{strings.tasksRepeatEvery()}</Text>
              <input
                type="number"
                min={1}
                max={365}
                value={customInterval}
                aria-label={strings.tasksRepeatInterval()}
                onChange={(event) => {
                  setCustomDirty(true);
                  setCustomInterval(Number(event.target.value));
                }}
                style={{ ...controlStyle, width: 70 }}
              />
              <select
                value={customFrequency}
                aria-label={strings.tasksRepeatFrequency()}
                onChange={(event) => {
                  setCustomDirty(true);
                  setCustomFrequency(event.target.value as CustomFrequency);
                }}
                style={{ ...controlStyle, width: 130 }}
              >
                <option value="DAILY">{strings.tasksDays()}</option>
                <option value="WEEKLY">{strings.tasksWeeks()}</option>
                <option value="MONTHLY">{strings.tasksMonths()}</option>
                <option value="YEARLY">{strings.tasksYears()}</option>
              </select>
              {customFrequency === "WEEKLY" &&
                WEEKDAYS.map((day) => (
                  <label
                    key={day}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={customDays.includes(day)}
                      onChange={() => {
                        setCustomDirty(true);
                        setCustomDays((current) =>
                          current.includes(day)
                            ? current.filter((value) => value !== day)
                            : WEEKDAYS.filter(
                                (value) =>
                                  value === day || current.includes(value)
                              )
                        );
                      }}
                    />
                    {day}
                  </label>
                ))}
            </Flex>
          </TaskControl>
        ) : null}
        <TaskControl label={strings.tasksPriority()}>
          <select
            aria-label={strings.tasksPriority()}
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            style={controlStyle}
          >
            <option value="none">{strings.tasksPriorityNone()}</option>
            <option value="low">{strings.tasksPriorityLow()}</option>
            <option value="medium">{strings.tasksPriorityMedium()}</option>
            <option value="high">{strings.tasksPriorityHigh()}</option>
          </select>
        </TaskControl>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={flagged}
            onChange={(event) => setFlagged(event.target.checked)}
          />
          <Text>{strings.tasksFlag()}</Text>
        </label>
        {task ? (
          <Flex sx={{ justifyContent: "space-between", gap: 2, pt: 2 }}>
            <Button variant="secondary" onClick={toggleCompletion}>
              {task.completed
                ? strings.tasksUncomplete()
                : strings.tasksComplete()}
            </Button>
            <Button
              className="veyran-task-destructive"
              variant="secondary"
              onClick={remove}
            >
              {strings.tasksDelete()}
            </Button>
          </Flex>
        ) : null}
      </Flex>
    </Dialog>
  );
});

function TaskControl(props: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text as="div" variant="subBody" sx={{ mb: 1, color: "paragraph" }}>
        {props.label}
      </Text>
      {props.children}
    </Box>
  );
}

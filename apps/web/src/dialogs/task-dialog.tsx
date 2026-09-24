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

type TaskDialogProps = BaseDialogProps<boolean> & {
  task?: TaskRecord;
  lists: TaskListRecord[];
  defaultListId?: string;
};

const presetRules = {
  none: "",
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY"
} as const;
type RepeatPreset = keyof typeof presetRules | "custom";

function presetForRule(rule?: string): RepeatPreset {
  if (!rule) return "none";
  const match = Object.entries(presetRules).find(([, value]) => value === rule);
  return (match?.[0] as RepeatPreset | undefined) || "custom";
}

function localDatetimeValue(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
  const [dueDate, setDueDate] = useState(task?.dueDate || "");
  const [dueTime, setDueTime] = useState(task?.dueTime || "");
  const [reminder, setReminder] = useState(
    localDatetimeValue(task?.reminderAt)
  );
  const [priority, setPriority] = useState<TaskPriority>(
    task?.priority || "none"
  );
  const [flagged, setFlagged] = useState(task?.flagged || false);
  const [repeatPreset, setRepeatPreset] = useState<RepeatPreset>(
    presetForRule(task?.recurrenceRule)
  );
  const [customRule, setCustomRule] = useState(task?.recurrenceRule || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim() || !listId || saving) return;
    const recurrenceRule =
      repeatPreset === "custom" ? customRule.trim() : presetRules[repeatPreset];
    const reminderAt = reminder ? new Date(reminder).getTime() : undefined;
    if (reminder && !Number.isFinite(reminderAt)) {
      showToast("error", strings.tasksInvalidReminder());
      return;
    }
    if (repeatPreset === "custom" && !recurrenceRule) {
      showToast("error", strings.tasksInvalidRecurrence());
      return;
    }
    if (recurrenceRule && !dueDate) {
      showToast("error", strings.tasksRepeatNeedsDueDate());
      return;
    }

    const input: TaskInput = {
      title: title.trim(),
      description: description.trim() || undefined,
      listId,
      dueDate: dueDate || undefined,
      dueTime: dueDate && dueTime ? dueTime : undefined,
      reminderAt,
      recurrenceRule: recurrenceRule || undefined,
      priority,
      flagged
    };

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
      <Flex sx={{ flexDirection: "column", gap: 3 }}>
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
        <TaskControl label={strings.tasksList()}>
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
        </TaskControl>
        <Flex sx={{ gap: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 180px" }}>
            <TaskControl label={strings.tasksDueDate()}>
              <input
                type="date"
                aria-label={strings.tasksDueDate()}
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                  if (!event.target.value) setDueTime("");
                }}
                style={controlStyle}
              />
            </TaskControl>
          </Box>
          <Box sx={{ flex: "1 1 140px" }}>
            <TaskControl label={strings.tasksDueTime()}>
              <input
                type="time"
                aria-label={strings.tasksDueTime()}
                disabled={!dueDate}
                value={dueTime}
                onChange={(event) => setDueTime(event.target.value)}
                style={controlStyle}
              />
            </TaskControl>
          </Box>
        </Flex>
        <TaskControl label={strings.tasksReminder()}>
          <input
            type="datetime-local"
            aria-label={strings.tasksReminder()}
            value={reminder}
            onChange={(event) => setReminder(event.target.value)}
            style={controlStyle}
          />
        </TaskControl>
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
            <option value="weekly">{strings.tasksWeekly()}</option>
            <option value="monthly">{strings.tasksMonthly()}</option>
            <option value="yearly">{strings.tasksYearly()}</option>
            <option value="custom">{strings.tasksCustom()}</option>
          </select>
        </TaskControl>
        {repeatPreset === "custom" ? (
          <TaskControl label="RRULE">
            <input
              aria-label="RRULE"
              placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
              value={customRule}
              onChange={(event) => setCustomRule(event.target.value)}
              style={controlStyle}
            />
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
            <Button variant="secondary" onClick={remove}>
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

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

import { Box, Flex, Text } from "@theme-ui/components";
import {
  DEFAULT_TASK_LIST_COLOR,
  DEFAULT_TASK_LIST_SYMBOL,
  TASK_LIST_COLORS,
  TASK_LIST_SYMBOLS
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useState } from "react";
import Dialog from "../components/dialog";
import {
  TaskListGlyph,
  taskListColorValue
} from "../components/task-list-appearance";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import { TaskListRecord, taskDomain } from "../common/task-domain";
import { logger } from "../utils/logger";
import { showToast } from "../utils/toast";

type Props = BaseDialogProps<boolean> & { list?: TaskListRecord };

export const TaskListDialog = DialogManager.register(function TaskListDialog(
  props: Props
) {
  const [name, setName] = useState(props.list?.name || "");
  const [symbol, setSymbol] = useState(
    props.list?.symbol || DEFAULT_TASK_LIST_SYMBOL
  );
  const [color, setColor] = useState(
    props.list?.color || DEFAULT_TASK_LIST_COLOR
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      if (props.list)
        await taskDomain.taskLists.update(props.list.id, {
          name: name.trim(),
          symbol,
          color
        });
      else
        await taskDomain.taskLists.create({ name: name.trim(), symbol, color });
      props.onClose(true);
    } catch (cause) {
      logger.error(cause);
      showToast("error", strings.tasksCouldNotSave());
      setSaving(false);
    }
  }

  return (
    <Dialog
      isOpen
      width={480}
      title={props.list ? strings.tasksEditList() : strings.tasksNewList()}
      testId="task-list-dialog"
      onClose={() => props.onClose(false)}
      positiveButton={{
        text: props.list ? strings.tasksSave() : strings.tasksCreateList(),
        disabled: !name.trim() || saving,
        onClick: save
      }}
      negativeButton={{
        text: strings.cancel(),
        onClick: () => props.onClose(false)
      }}
    >
      <Flex sx={{ flexDirection: "column", gap: 3 }}>
        <Flex
          sx={{
            alignItems: "center",
            gap: 2,
            p: 2,
            borderRadius: 8,
            bg: "background-secondary"
          }}
        >
          <TaskListGlyph symbol={symbol} color={color} size={30} />
          <Text sx={{ fontWeight: "bold" }}>
            {name || strings.tasksNewList()}
          </Text>
        </Flex>
        <Box>
          <label
            htmlFor="task-list-name"
            style={{ display: "block", marginBottom: 8 }}
          >
            {strings.tasksEnterListName()}
          </label>
          <input
            id="task-list-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: 9,
              borderRadius: 8,
              border: "1px solid var(--border)",
              color: "var(--paragraph)",
              background: "var(--background)",
              font: "inherit"
            }}
          />
        </Box>
        <Box>
          <Text as="div" variant="subBody" sx={{ mb: 2 }}>
            {strings.tasksListIcon()}
          </Text>
          <div
            role="group"
            aria-label={strings.tasksListIcon()}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 1fr)",
              gap: 8
            }}
          >
            {TASK_LIST_SYMBOLS.map((item) => (
              <button
                key={item}
                type="button"
                aria-label={item.replaceAll(".", " ")}
                aria-pressed={item === symbol}
                onClick={() => setSymbol(item)}
                style={{
                  height: 46,
                  borderRadius: 10,
                  border:
                    item === symbol
                      ? "2px solid var(--accent)"
                      : "1px solid var(--border)",
                  background:
                    item === symbol
                      ? "var(--background-selected)"
                      : "var(--background)",
                  cursor: "pointer"
                }}
              >
                <span style={{ display: "flex", justifyContent: "center" }}>
                  <TaskListGlyph symbol={item} color={color} />
                </span>
              </button>
            ))}
          </div>
        </Box>
        <Box>
          <Text as="div" variant="subBody" sx={{ mb: 2 }}>
            {strings.tasksListColor()}
          </Text>
          <Flex
            role="group"
            aria-label={strings.tasksListColor()}
            sx={{ gap: 2, flexWrap: "wrap" }}
          >
            {TASK_LIST_COLORS.map((item) => (
              <button
                key={item}
                type="button"
                aria-label={item}
                aria-pressed={item === color}
                onClick={() => setColor(item)}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: taskListColorValue(item),
                  border:
                    item === color
                      ? "3px solid var(--paragraph)"
                      : "2px solid var(--background)",
                  boxShadow:
                    item === color ? "0 0 0 1px var(--border)" : "none",
                  cursor: "pointer"
                }}
              />
            ))}
          </Flex>
        </Box>
      </Flex>
    </Dialog>
  );
});

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
import { useEffect, useRef, useState } from "react";
import { Popup } from "../components/popup.js";
import { useIsMobile, useIsMacCatalyst } from "../stores/toolbar-store.js";
import { InlineInput } from "../../components/inline-input/index.js";
import { strings } from "@notesnook/intl";

const MAX_COLUMNS = 20;
const MAX_ROWS = 20;
const MIN_COLUMNS = 10;
const MIN_ROWS = 6;

type CellLocation = { column: number; row: number };
type TableSize = { columns: number; rows: number };

export type TablePopupProps = {
  onInsertTable: (size: TableSize) => void;
};
export function TablePopup(props: TablePopupProps) {
  const isMobile = useIsMobile();
  const isMac = useIsMacCatalyst();
  const sizeFields = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMac) return;
    // WKWebView may ignore autoFocus while the popup portal is mounting.
    // One owned frame retries after insertion, never on selection/size updates.
    const frame = requestAnimationFrame(() =>
      sizeFields.current?.querySelector<HTMLInputElement>("input")?.focus()
    );
    return () => cancelAnimationFrame(frame);
  }, [isMac]);
  const autoExpand = !isMobile;
  const cellSize = isMobile ? 30 : 15;

  const { onInsertTable } = props;
  const [cellLocation, setCellLocation] = useState<CellLocation>({
    column: isMac ? 1 : 0,
    row: isMac ? 1 : 0
  });
  const [tableSize, setTableSize] = useState<TableSize>({
    columns: MIN_COLUMNS,
    rows: MIN_ROWS
  });
  const validSize = isMac
    ? Number.isInteger(cellLocation.column) &&
      Number.isInteger(cellLocation.row) &&
      cellLocation.column >= 1 &&
      cellLocation.column <= MAX_COLUMNS &&
      cellLocation.row >= 1 &&
      cellLocation.row <= MAX_ROWS
    : !!cellLocation.column && !!cellLocation.row;
  const insertSize = () => {
    if (validSize)
      onInsertTable({ columns: cellLocation.column, rows: cellLocation.row });
  };

  useEffect(() => {
    if (!autoExpand) return;
    setTableSize((old) => {
      const { columns, rows } = old;
      const { column, row } = cellLocation;

      const isDecrease = row === rows - 2 || column === columns - 2;

      const rowFactor = Number(row === rows || row === rows - 2);
      const columnFactor = Number(column === columns || column === columns - 2);

      return {
        columns: isDecrease
          ? Math.max(column + columnFactor, MIN_COLUMNS)
          : Math.min(old.columns + columnFactor, MAX_COLUMNS),
        rows: isDecrease
          ? Math.max(row + rowFactor, MIN_ROWS)
          : Math.min(old.rows + rowFactor, MAX_ROWS)
      };
    });
  }, [cellLocation, autoExpand]);

  return (
    <Popup
      action={{
        title: !validSize
          ? strings.setTableSizeNotice()
          : strings.insertTableOfSize(cellLocation.row, cellLocation.column),
        disabled: !validSize,
        onClick: insertSize
      }}
    >
      <Flex
        sx={{ px: 1, pt: 1, flexDirection: "column", alignItems: "center" }}
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: `repeat(${tableSize.columns}, minmax(${cellSize}px, 1fr))`, // "1fr ".repeat(tableSize.columns),
            gap: "small",
            bg: "background",
            width: "100%"
          }}
          onTouchMove={(e) => {
            const touch = e.touches.item(0);
            const element = document.elementFromPoint(
              touch.pageX,
              touch.pageY
            ) as HTMLElement;
            if (!element) return;
            const index = element.dataset.index;
            if (!index) return;
            setCellLocation(getCellLocation(parseInt(index), tableSize));
          }}
        >
          {Array(tableSize.columns * tableSize.rows)
            .fill(0)
            .map((_, index) => (
              <Box
                key={index}
                as={isMac ? "button" : "div"}
                {...(isMac ? { type: "button" as const } : {})}
                aria-label={
                  isMac
                    ? strings.insertTableOfSize(
                        getCellLocation(index, tableSize).row,
                        getCellLocation(index, tableSize).column
                      )
                    : undefined
                }
                tabIndex={isMac ? -1 : undefined}
                data-index={index}
                sx={{
                  ...(isMac ? { p: 0 } : {}),
                  height: cellSize || 15,
                  borderRadius: "small",
                  border: "1px solid",
                  ...(isCellHighlighted(index, cellLocation, tableSize)
                    ? {
                        bg: "background-selected",
                        borderColor: "transparent"
                      }
                    : { bg: "background-secondary", borderColor: "border" }),
                  ...(isMac
                    ? {
                        ":focus-visible": {
                          outline: "2px solid",
                          outlineColor: "accent",
                          outlineOffset: 1
                        }
                      }
                    : {})
                }}
                // Catalyst keeps keyboard entry in the named size fields.
                // The grid is an alternative pointer/assistive click route.
                onMouseDown={(event) => {
                  if (isMac) event.preventDefault();
                }}
                onTouchStart={() => {
                  setCellLocation(getCellLocation(index, tableSize));
                }}
                onMouseEnter={() => {
                  setCellLocation(getCellLocation(index, tableSize));
                }}
                onTouchEnd={(e) => {
                  if (!isMac) e.preventDefault();
                }}
                onClick={() => {
                  const location = isMac
                    ? getCellLocation(index, tableSize)
                    : cellLocation;
                  onInsertTable({
                    columns: location.column,
                    rows: location.row
                  });
                }}
              />
            ))}
        </Box>
        <Flex
          ref={sizeFields}
          onKeyDown={(event) => {
            if (!isMac) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              insertSize();
            } else if (event.key.startsWith("Arrow")) {
              event.stopPropagation();
            } else if (
              event.key === "Tab" ||
              event.code === "Tab" ||
              event.keyCode === 9
            ) {
              if (event.ctrlKey || event.metaKey || event.altKey) return;
              // Catalyst may keep native key traversal on the first field.
              // Own only the interior step; boundary Tab and Escape stay free.
              const inputs = sizeFields.current?.querySelectorAll("input");
              if (!inputs || inputs.length !== 2) return;
              const from = event.shiftKey ? inputs[1] : inputs[0];
              const to = event.shiftKey ? inputs[0] : inputs[1];
              if (event.target !== from) return;
              event.preventDefault();
              event.stopPropagation();
              to.focus();
            }
          }}
          sx={{
            display: isMac ? "flex" : ["flex", "none", "none"],
            mt: 1,
            alignItems: "center",
            justifyContent: "center",
            maxWidth: "100%"
          }}
        >
          <InlineInput
            containerProps={{ sx: { mr: 1, flexShrink: 1 } }}
            label={isMac ? strings.tableColumns() : "columns"}
            aria-label={isMac ? strings.tableColumns() : undefined}
            autoFocus={isMac}
            min={isMac ? 1 : undefined}
            max={isMac ? MAX_COLUMNS : undefined}
            step={isMac ? 1 : undefined}
            placeholder={
              isMac ? strings.tableColumns() : `${cellLocation.column} columns`
            }
            type="number"
            value={cellLocation.column}
            onChange={(e) => {
              setCellLocation((l) => ({
                ...l,
                column: e.target.valueAsNumber || 0
              }));
            }}
          />
          <InlineInput
            containerProps={{ sx: { flexShrink: 1 } }}
            label={isMac ? strings.tableRows() : "rows"}
            aria-label={isMac ? strings.tableRows() : undefined}
            min={isMac ? 1 : undefined}
            max={isMac ? MAX_ROWS : undefined}
            step={isMac ? 1 : undefined}
            placeholder={
              isMac ? strings.tableRows() : `${cellLocation.row} rows`
            }
            type="number"
            value={cellLocation.row}
            onChange={(e) => {
              setCellLocation((l) => ({
                ...l,
                row: e.target.valueAsNumber || 0
              }));
            }}
          />
        </Flex>
        <Text
          variant={"body"}
          sx={{ mt: 1, display: isMac ? "none" : ["none", "block", "block"] }}
        >
          {cellLocation.column} x {cellLocation.row}
        </Text>
      </Flex>
    </Popup>
  );
}

function getCellLocation(index: number, tableSize: TableSize): CellLocation {
  const cellIndex = index + 1;
  const column = cellIndex % tableSize.columns;
  let row = cellIndex / tableSize.columns;
  const flooredRow = Math.floor(row);
  row = row === flooredRow ? row : flooredRow + 1;

  return { column: column ? column : tableSize.columns, row };
}

function isCellHighlighted(
  index: number,
  currentCellLocation: CellLocation,
  tableSize: TableSize
) {
  const cellLocation = getCellLocation(index, tableSize);
  return (
    cellLocation.row <= currentCellLocation.row &&
    cellLocation.column <= currentCellLocation.column
  );
}

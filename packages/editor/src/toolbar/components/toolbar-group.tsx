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

import { ToolbarGroupDefinition, ToolButtonVariant } from "../types.js";
import { findTool } from "../tools/index.js";
import { Flex, FlexProps } from "@theme-ui/components";
import { Editor } from "../../types.js";
import { MoreTools } from "./more-tools.js";
import { getToolDefinition } from "../tool-definitions.js";
import { strings } from "@notesnook/intl";

/**
 * Reserved namespace for the "more" popups produced by this component. A
 * collapsed group uses its tools' joined ids as a group id, so a single-tool
 * group (`[["headings"]]`, id `"headings"`) would otherwise give its "more"
 * popup the id of the leaf popup it contains (`Headings`' dropdown is also
 * `"headings"`): opening "more" would immediately open the leaf menu too, and
 * the two could never be toggled independently. Prefixing keeps the popup that
 * *contains* the tools distinct from the tools' own popups. No `ToolId` and no
 * leaf popup id (`headings`, `macFormat`, ...) starts with this prefix.
 */
const MORE_POPUP_ID_PREFIX = "more-";

export type ToolbarGroupProps = FlexProps & {
  tools: ToolbarGroupDefinition;
  editor: Editor;
  variant?: ToolButtonVariant;
  force?: boolean;
  groupId: string;
};
export function ToolbarGroup(props: ToolbarGroupProps) {
  const { tools, editor, force, sx, groupId, ...flexProps } = props;

  return (
    <Flex
      className="toolbar-group"
      sx={{
        gap: [0, 0, "small"],
        p: ["4px", "4px", "small"],
        flexShrink: 0,
        ...sx
      }}
      {...flexProps}
    >
      {tools.map((toolId) => {
        if (Array.isArray(toolId)) {
          return (
            <MoreTools
              parentGroup={groupId}
              key={"more-tools"}
              title={strings.more()}
              icon="more"
              popupId={`${MORE_POPUP_ID_PREFIX}${toolId.join("")}`}
              tools={toolId}
              editor={editor}
            />
          );
        } else {
          const Component = findTool(toolId);
          const toolDefinition = getToolDefinition(toolId);
          return (
            <Component
              parentGroup={groupId}
              key={toolDefinition.title}
              editor={editor}
              force={force}
              {...toolDefinition}
            />
          );
        }
      })}
    </Flex>
  );
}

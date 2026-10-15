// SPDX-License-Identifier: GPL-3.0-or-later
import { ToolProps } from "../types.js";
import { ToolButton } from "../components/tool-button.js";

export function Undo(props: ToolProps) {
  return (
    <ToolButton
      icon={props.icon}
      title={props.title}
      aria-label={props.title}
      disabled={!props.editor.can().undo()}
      onClick={() => props.editor.chain().focus().undo().run()}
    />
  );
}
export function Redo(props: ToolProps) {
  return (
    <ToolButton
      icon={props.icon}
      title={props.title}
      aria-label={props.title}
      disabled={!props.editor.can().redo()}
      onClick={() => props.editor.chain().focus().redo().run()}
    />
  );
}
export function CloseKeyboard(props: ToolProps) {
  return (
    <ToolButton
      icon={props.icon}
      title={props.title}
      aria-label={props.title}
      onClick={() => {
        props.editor.commands.blur();
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      }}
    />
  );
}

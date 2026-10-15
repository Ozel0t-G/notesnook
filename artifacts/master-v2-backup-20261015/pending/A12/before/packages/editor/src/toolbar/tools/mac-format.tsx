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

import { Flex, Text } from "@theme-ui/components";
import { ToolButton } from "../components/tool-button.js";
import { ToolbarGroup } from "../components/toolbar-group.js";
import { PopupParentContext } from "../stores/toolbar-store.js";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { MenuItem } from "@notesnook/ui";
import { ToolProps } from "../types.js";
import { Dropdown } from "../components/dropdown.js";
import { strings } from "@notesnook/intl";
import { CodeBlock } from "../../extensions/code-block/index.js";
import { IosFormatContext, useToolbarStore } from "../stores/toolbar-store.js";
import { Button } from "../../components/button.js";
import {
  resolveAppleSurfaces,
  useThemeColors,
  useThemeEngineStore
} from "@notesnook/theme";

/**
 * Mac Catalyst "Aa" format button (WP08 R6).
 *
 * macOS Notes has no font-size stepper or font-family dropdown: paragraph
 * styles, inline styles and lists all live behind a single "Aa" button. This
 * tool reuses the toolbar's existing dropdown/popup mechanism and runs exactly
 * the commands the individual mobile tools run, so it stays consistent with
 * them (including clearing a manual `textStyle` override when a heading is
 * applied, the way the `headings` tool does).
 *
 * iPhone/iPad reuse these commands through `IosFormatContext`: one bounded
 * Aa column with a main/advanced page, never a second formatting shelf. Mac
 * Catalyst and Android retain their existing menu presentation.
 */
export function MacFormat(props: ToolProps) {
  const { editor } = props;
  const isIosFormat = useContext(IosFormatContext);
  const { colors } = useThemeColors("base");
  const theme = useThemeEngineStore((store) => store.theme);
  const selectionFill = resolveAppleSurfaces({
    theme,
    colors,
    isDark: theme.colorScheme === "dark"
  }).selectionFill;
  const [advanced, setAdvanced] = useState(false);
  const aaRef = useRef<HTMLButtonElement>();
  const moreRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<"main" | "advanced" | "trigger">();
  const isOpen = useToolbarStore((store) => store.isPopupOpen("macFormat"));
  useEffect(() => {
    // Move focus only for keyboard/assistive activation of a focused button.
    // Touch activation keeps the editor's focus and software keyboard intact.
    if (focusRequest.current) {
      const target =
        focusRequest.current === "trigger"
          ? aaRef.current
          : focusRequest.current === "advanced"
          ? backRef.current
          : moreRef.current;
      target?.focus({ preventScroll: true });
      focusRequest.current = undefined;
    }
    if (!isOpen) setAdvanced(false);
  }, [isOpen, advanced]);

  const items: MenuItem[] = [
    {
      type: "button",
      key: "mac-title",
      title: strings.formatTitle(),
      isChecked: editor.isActive("heading", { level: 1 }),
      onClick: () => setHeading(1)
    },
    {
      type: "button",
      key: "mac-heading",
      title: strings.formatHeading(),
      isChecked: editor.isActive("heading", { level: 2 }),
      onClick: () => setHeading(2)
    },
    {
      type: "button",
      key: "mac-subheading",
      title: strings.formatSubheading(),
      isChecked: editor.isActive("heading", { level: 3 }),
      onClick: () => setHeading(3)
    },
    {
      type: "button",
      key: "mac-body",
      title: strings.formatBody(),
      isChecked:
        !editor.isActive("heading") &&
        !editor.isActive("code") &&
        !editor.isActive(CodeBlock.name),
      onClick: () => editor.chain().focus().setParagraph().run()
    },
    {
      type: "button",
      key: "mac-monospaced",
      title: strings.formatMonospaced(),
      isChecked: editor.isActive("code"),
      onClick: () => editor.chain().focus().toggleCode().run()
    },
    { type: "separator", key: "mac-separator-inline" },
    {
      type: "button",
      key: "mac-bold",
      title: strings.bold(),
      isChecked: editor.isActive("bold"),
      onClick: () => editor.chain().focus().toggleBold().run()
    },
    {
      type: "button",
      key: "mac-italic",
      title: strings.italic(),
      isChecked: editor.isActive("italic"),
      onClick: () => editor.chain().focus().toggleItalic().run()
    },
    {
      type: "button",
      key: "mac-underline",
      title: strings.underline(),
      isChecked: editor.isActive("underline"),
      onClick: () => editor.chain().focus().toggleUnderline().run()
    },
    {
      type: "button",
      key: "mac-strikethrough",
      title: strings.strikethrough(),
      isChecked: editor.isActive("strike"),
      onClick: () => editor.chain().focus().toggleStrike().run()
    },
    { type: "separator", key: "mac-separator-lists" },
    {
      type: "button",
      key: "mac-bullet-list",
      title: strings.bulletList(),
      isChecked: editor.isActive("bulletList"),
      onClick: () => editor.chain().focus().toggleBulletList().run()
    },
    {
      type: "button",
      key: "mac-numbered-list",
      title: strings.numberedList(),
      isChecked: editor.isActive("orderedList"),
      onClick: () => editor.chain().focus().toggleOrderedList().run()
    },
    {
      type: "button",
      key: "mac-checklist",
      title: strings.checklist(),
      isChecked: editor.isActive("checkList"),
      onClick: () => editor.chain().focus().toggleCheckList().run()
    }
  ];

  // Menu renders popup item components as React types. Keep those types
  // stable while the host rerenders for selection or keyboard focus; otherwise
  // nested LinkTool state and the active Aa button are discarded mid-action.
  const IosInline = useMemo(
    () =>
      function IosInline() {
        return (
          <Flex
            sx={{
              gap: "small",
              p: "small",
              border: "1px solid",
              borderColor: "border",
              borderRadius: "default",
              m: "small"
            }}
          >
            <ToolButton
              id="ios-aa-bold"
              icon="bold"
              title={strings.bold()}
              aria-label={strings.bold()}
              tabIndex={0}
              toggled={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
            <ToolButton
              id="ios-aa-italic"
              icon="italic"
              title={strings.italic()}
              aria-label={strings.italic()}
              tabIndex={0}
              toggled={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
            <ToolButton
              id="ios-aa-underline"
              icon="underline"
              title={strings.underline()}
              aria-label={strings.underline()}
              tabIndex={0}
              toggled={editor.isActive("underline")}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
          </Flex>
        );
      },
    [editor]
  );
  const IosLists = useMemo(
    () =>
      function IosLists() {
        return (
          <Flex
            sx={{
              gap: "small",
              p: "small",
              border: "1px solid",
              borderColor: "border",
              borderRadius: "default",
              m: "small"
            }}
          >
            <ToolButton
              id="ios-aa-bulletList"
              icon="bulletList"
              title={strings.bulletList()}
              aria-label={strings.bulletList()}
              tabIndex={0}
              toggled={editor.isActive("bulletList")}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
            <ToolButton
              id="ios-aa-numberedList"
              icon="numberedList"
              title={strings.numberedList()}
              aria-label={strings.numberedList()}
              tabIndex={0}
              toggled={editor.isActive("orderedList")}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
            <ToolButton
              id="ios-aa-checklist"
              icon="checklist"
              title={strings.checklist()}
              aria-label={strings.checklist()}
              tabIndex={0}
              toggled={editor.isActive("checkList")}
              onClick={() => editor.chain().focus().toggleCheckList().run()}
              sx={{ flex: 1, minHeight: 44 }}
            />
          </Flex>
        );
      },
    [editor]
  );
  const IosFormatHeader = useMemo(
    () =>
      function IosFormatHeader() {
        return (
          <Flex
            sx={{
              alignItems: "center",
              justifyContent: "space-between",
              px: "small",
              position: "sticky",
              top: 0,
              zIndex: 1,
              bg: "background"
            }}
          >
            <Text
              sx={{ fontSize: "title", fontWeight: "bold", color: "paragraph" }}
            >
              {strings.formatting()}
            </Text>
            <Button
              id="ios-aa-done"
              variant="secondary"
              title={strings.done()}
              aria-label={strings.done()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                if (document.activeElement === event.currentTarget)
                  focusRequest.current = "trigger";
                useToolbarStore.getState().closePopup("macFormat");
              }}
              sx={{ minHeight: 44, px: "small", color: "accent" }}
            >
              <Text sx={{ fontSize: "title", color: "accent" }}>
                {strings.done()}
              </Text>
            </Button>
          </Flex>
        );
      },
    []
  );
  const IosMoreFormatting = useMemo(
    () =>
      function IosMoreFormatting() {
        return (
          <ToolButton
            id="ios-more-formatting"
            icon="chevronRight"
            title={strings.formatting()}
            aria-label={strings.formatting()}
            aria-expanded={false}
            aria-controls="ios-aa-advanced"
            buttonRef={moreRef}
            onClick={(event) => {
              if (document.activeElement === event.currentTarget)
                focusRequest.current = "advanced";
              setAdvanced(true);
            }}
            sx={{
              width: "100%",
              minHeight: 44,
              px: "small",
              display: "flex",
              flexDirection: "row-reverse",
              justifyContent: "space-between",
              border: "1px solid",
              borderColor: "border",
              borderRadius: "default"
            }}
          >
            <Text sx={{ fontSize: "title" }}>{strings.formatting()}</Text>
          </ToolButton>
        );
      },
    []
  );
  const IosAdvancedFormatting = useMemo(
    () =>
      function IosAdvancedFormatting() {
        return (
          <PopupParentContext.Provider value="macFormat">
            <Flex
              data-test-id="ios-aa-advanced"
              id="ios-aa-advanced"
              role="group"
              aria-label={strings.formatting()}
              sx={{ flexDirection: "column", gap: "small", p: "small" }}
            >
              <ToolButton
                id="ios-aa-back"
                icon="chevronLeft"
                iconColor="accent"
                title={strings.back()}
                aria-label={strings.back()}
                buttonRef={backRef}
                onClick={(event) => {
                  if (document.activeElement === event.currentTarget)
                    focusRequest.current = "main";
                  // Leaving this page must not keep its child font/color
                  // popup recorded, ready to reopen on the next visit.
                  // Independent pinned toolbar menus are outside this parent.
                  const store = useToolbarStore.getState();
                  for (const popup of Object.values(store.openedPopups)) {
                    if (popup && popup.parent === "macFormat")
                      store.closePopup(popup.id);
                  }
                  setAdvanced(false);
                }}
                sx={{
                  minHeight: 44,
                  px: "small",
                  display: "flex",
                  justifyContent: "flex-start",
                  gap: "small"
                }}
              >
                <Text sx={{ fontSize: "title", color: "accent" }}>
                  {strings.back()}
                </Text>
              </ToolButton>
              <AdvancedFormattingSections
                editor={editor}
                groupId="ios-aa-advanced"
                touch
              />
            </Flex>
          </PopupParentContext.Provider>
        );
      },
    [editor]
  );

  const iosItems: MenuItem[] = [
    { type: "popup", key: "ios-format-header", component: IosFormatHeader },
    {
      type: "popup",
      key: "ios-inline",
      component: IosInline
    },
    ...items
      .filter((item) =>
        [
          "mac-title",
          "mac-heading",
          "mac-subheading",
          "mac-body",
          "mac-monospaced"
        ].includes(item.key)
      )
      .map((item, index) =>
        item.type === "button"
          ? {
              ...item,
              styles: {
                ...item.styles,
                button: {
                  minHeight: 44,
                  mx: "small",
                  px: "small",
                  border: "1px solid",
                  borderColor: "border",
                  borderTopWidth: index === 0 ? 1 : 0,
                  borderTopLeftRadius: index === 0 ? "default" : 0,
                  borderTopRightRadius: index === 0 ? "default" : 0,
                  borderBottomLeftRadius: index === 4 ? "default" : 0,
                  borderBottomRightRadius: index === 4 ? "default" : 0,
                  bg: item.isChecked ? selectionFill : "transparent",
                  ":focus-visible": {
                    outline: "2px solid",
                    outlineColor: "accent",
                    outlineOffset: -2
                  }
                },
                icon: { display: "none" },
                title: {
                  ...item.styles?.title,
                  fontSize: "title",
                  fontWeight: index < 2 ? "bold" : "normal",
                  ...(item.key === "mac-monospaced"
                    ? { fontFamily: "monospace" }
                    : {})
                }
              }
            }
          : item
      ),
    { type: "separator", key: "ios-separator-lists" },
    {
      type: "popup",
      key: "ios-lists",
      component: IosLists
    },
    {
      type: "popup",
      key: "ios-more-formatting",
      component: IosMoreFormatting
    }
  ];

  return (
    <Dropdown
      id="macFormat"
      group="macFormat"
      buttonRef={aaRef}
      selectedItem="Aa"
      items={
        isIosFormat
          ? advanced
            ? [
                {
                  type: "popup",
                  key: "ios-format-header",
                  component: IosFormatHeader
                },
                {
                  type: "popup",
                  key: "ios-advanced-formatting",
                  component: IosAdvancedFormatting
                }
              ]
            : iosItems
          : items
      }
      menuWidth={isIosFormat ? 320 : 200}
      menuLayout={isIosFormat ? "column" : undefined}
      ariaLabel={`Aa ${strings.formatting()}`}
    />
  );

  function setHeading(level: 1 | 2 | 3) {
    editor
      ?.chain()
      .focus()
      .updateAttributes("textStyle", { fontSize: null, fontStyle: null })
      .setHeading({ level })
      .run();
  }
}

/** Shared actual tools; presentation hosts supply their own chrome and popup parent. */
export function AdvancedFormattingSections({
  editor,
  groupId,
  touch = false,
  presentation,
  onExternalLink
}: Pick<ToolProps, "editor"> & {
  groupId: string;
  touch?: boolean;
  /** Native Mac host only; default/touch hosts keep their existing layout. */
  presentation?: "mac";
  onExternalLink?: () => void;
}) {
  const macPresentation = presentation === "mac" && !touch;
  const sections = [
    {
      title: strings.link(),
      tools: ["addLink", "addInternalLink"] as const
    },
    {
      title: `${strings.highlight()} · ${strings.textColor()}`,
      tools: ["highlight", "textColor"] as const
    },
    {
      title: `${strings.fontSize()} · ${strings.fontFamily()}`,
      tools: ["fontSize", "fontFamily"] as const
    },
    {
      title: strings.formatting(),
      tools: [
        "strikethrough",
        "subscript",
        "superscript",
        "code",
        "math",
        "alignment",
        "textDirection",
        "clearformatting"
      ] as const
    }
  ];
  return (
    <>
      {" "}
      {sections.map((section, index) => (
        <Flex
          key={index}
          sx={{ flexDirection: "column", gap: macPresentation ? 1 : "small" }}
        >
          <Text
            sx={{
              fontSize: macPresentation ? "body" : "subBody",
              fontWeight: macPresentation ? "medium" : undefined,
              color: "paragraph-secondary"
            }}
          >
            {section.title}
          </Text>
          {index === 0 && onExternalLink ? (
            <ToolButton
              icon="link"
              title={strings.insertLink()}
              aria-label={strings.insertLink()}
              onClick={onExternalLink}
              sx={macPresentation ? { minHeight: 28, px: 1 } : undefined}
            />
          ) : null}
          <ToolbarGroup
            editor={editor}
            groupId={groupId}
            tools={
              onExternalLink && index === 0
                ? ["addInternalLink"]
                : [...section.tools]
            }
            sx={{
              p: macPresentation ? 1 : "small",
              gap: macPresentation ? 1 : "small",
              flexWrap: "wrap",
              minWidth: 0,
              flexShrink: 1,
              alignItems: "center",
              alignContent: "flex-start",
              border: "1px solid",
              borderColor: "border",
              borderRadius: "default",
              "&& > *": { height: "auto", minHeight: touch ? 44 : 28 }
            }}
          />
        </Flex>
      ))}
    </>
  );
}

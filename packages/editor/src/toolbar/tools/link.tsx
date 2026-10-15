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

import { ToolProps } from "../types.js";
import { ToolButton } from "../components/tool-button.js";
import { useContext, useEffect, useRef, useState } from "react";
import { ResponsivePresenter } from "../../components/responsive/index.js";
import { LinkPopup } from "../popups/link-popup.js";
import {
  LinkSettingsAutoOpenContext,
  useToolbarLocation
} from "../stores/toolbar-store.js";
import { MoreTools } from "../components/more-tools.js";
import { useRefValue } from "../../hooks/use-ref-value.js";
import { findMark, selectionToOffset } from "../../utils/prosemirror.js";
import { Flex, Link, Text } from "@theme-ui/components";
import { ImageNode } from "../../extensions/image/index.js";
import { Link as LinkNode } from "../../extensions/link/index.js";
import { getMarkAttributes } from "@tiptap/core";
import { useHoverPopupContext } from "../floating-menus/hover-popup/context.js";
import { strings } from "@notesnook/intl";
import { find } from "linkifyjs";
import { Icons } from "../icons.js";
import { mdiNoteOutline, mdiBookOutline, mdiPound } from "@mdi/js";
import { Icon } from "@notesnook/ui";
import { LinkData } from "../../types.js";
import {
  insertInternalLink,
  resolveActiveInternalLinkRange
} from "./internal-link-command.js";
import type { LinkAttributes } from "../../extensions/link/index.js";

export function LinkSettings(props: ToolProps) {
  const { editor } = props;
  const isBottom = useToolbarLocation() === "bottom";
  // Read the flag unconditionally, before any early return (hook order). When
  // the embedding app suppresses the *automatic* popup (the iOS quiet reading
  // presentation), render nothing: unmounting `MoreTools` also runs its
  // existing `autoCloseOnUnmount` cleanup, so an already-open popup closes and
  // re-opens with the flag. The tool, its commands and the toolbar lifecycle
  // are untouched.
  const autoOpenLinkSettings = useContext(LinkSettingsAutoOpenContext);
  if (!autoOpenLinkSettings) return null;
  if (!editor.isActive("link") || !isBottom) return null;

  return (
    <MoreTools
      {...props}
      autoOpen
      autoCloseOnUnmount
      popupId="linkSettings"
      tools={
        editor.isEditable
          ? ["openLink", "editLink", "removeLink", "copyLink"]
          : ["openLink", "copyLink"]
      }
    />
  );
}

export function AddLink(props: ToolProps) {
  const { editor } = props;

  const isActive = editor.isActive("link");

  if (isActive) return <EditLink {...props} icon={"linkEdit"} />;
  return (
    <LinkTool
      {...props}
      onDone={(attributes) => editor.commands.toggleLink(attributes)}
      onClick={() => {
        if (!editor) return;
        const selectedText = editor.state.doc.textBetween(
          editor.state.selection.from,
          editor.state.selection.to
        );
        const href =
          find(selectedText).find(
            (item) => item.isLink && item.href === selectedText
          )?.href ?? "";
        return { title: selectedText, href };
      }}
    />
  );
}

export function AddInternalLink(props: ToolProps) {
  const { editor } = props;
  const isActive = editor.isActive(LinkNode.name);

  return (
    <ToolButton
      icon={props.icon}
      title={props.title}
      disabled={isActive}
      onClick={() => {
        return insertInternalLink(editor);
      }}
    />
  );
}

export function EditLink(props: ToolProps) {
  const { editor } = props;
  const { selectedNode: _selectedNode, hide } = useHoverPopupContext();
  const selectedNode = useRefValue(
    _selectedNode || selectionToOffset(editor.state)
  );
  const { node } = _selectedNode || {};
  const link = node ? findMark(node, LinkNode.name) : null;
  const attrs = link?.attrs || getMarkAttributes(editor.state, LinkNode.name);

  if (!editor.isEditable) return null;
  if (attrs && isInternalLink(attrs.href))
    return (
      <ToolButton
        icon={props.icon}
        title={props.title}
        onClick={() => {
          hide();
          return insertInternalLink(editor, {
            // Let the host picker keep/prefill the existing internal link.
            attributes: attrs as LinkAttributes,
            range: selectedNode.current
              ? { from: selectedNode.current.from, to: selectedNode.current.to }
              : undefined
          });
        }}
      />
    );

  return (
    <LinkTool
      editor={props.editor}
      icon={props.icon}
      title={props.title}
      isEditing
      onDone={(attributes) => {
        if (selectedNode.current)
          editor.chain().focus().setTextSelection(selectedNode.current).run();
        editor.commands.setLink(attributes);
        hide();
      }}
      onClick={() => {
        if (!selectedNode.current) return;

        const { node } = selectedNode.current;
        if (!node) return;

        const selectedText = node.textContent;
        const mark = findMark(node, "link");

        if (!mark) return;
        return {
          title: selectedText,
          href: mark.attrs.href
        };
      }}
    />
  );
}

export function RemoveLink(props: ToolProps) {
  const { editor } = props;
  const { selectedNode, hide } = useHoverPopupContext();
  if (!editor.isEditable) return null;
  return (
    <ToolButton
      icon={props.icon}
      title={props.title}
      toggled={false}
      onClick={() => {
        // The hover context selects the hovered fragment of a link; without a
        // hover context (the bottom `LinkSettings` menu) the caret itself is
        // used — at the "normal ending caret" of a freshly created link it
        // rests on the plain spacer next to the link while the editor still
        // reports the link mark as active. In both cases resolve the *actual*
        // link run first: selecting a link's exact range (its full run, across
        // the bold/italic/color text nodes a formatted caption may be split
        // into) makes `unsetLink` remove that one link only and never a single
        // styled fragment or a neighbouring node.
        const hoveredNode = selectedNode?.node;
        const nodeMark = hoveredNode
          ? findMark(hoveredNode, LinkNode.name)
          : undefined;
        const attributes = (
          hoveredNode
            ? nodeMark?.attrs
            : getMarkAttributes(editor.state, LinkNode.name)
        ) as LinkAttributes | undefined;
        const hovered = selectedNode
          ? { from: selectedNode.from, to: selectedNode.to }
          : selectionToOffset(editor.state) ?? {
              from: editor.state.selection.from,
              to: editor.state.selection.to
            };
        const range = resolveActiveInternalLinkRange(
          editor,
          hovered,
          attributes
        );
        if (range) {
          // The exact link run the user is acting on: unlink that one only.
          editor.commands.setTextSelection(range);
          editor.chain().focus().unsetLink().run();
        } else if (hoveredNode && !hoveredNode.isText && nodeMark) {
          // A non-text node hand-off (e.g. an imported image that carries a
          // link mark) the inline resolver cannot reach keeps its previous
          // behavior: unlink the explicitly hovered node.
          editor.commands.setTextSelection(hovered);
          editor.chain().focus().unsetLink().run();
        }
        // Otherwise (plain text, no link context, an ambiguous boundary or any
        // unresolved range): a no-op. Selecting the range anyway could unlink a
        // neighbour from an empty selection at a boundary.
        hide();
      }}
    />
  );
}

export function OpenLink(props: ToolProps) {
  const { editor } = props;
  const { selectedNode: _selectedNode, hide } = useHoverPopupContext();
  const selectedNode = useRefValue(
    _selectedNode || selectionToOffset(editor.state)
  );
  const { node } = selectedNode.current || {};
  const link = node ? findMark(node, "link") : null;
  const href = link?.attrs.href ?? null;
  const [loading, setLoading] = useState(false);
  const [linkData, setLinkData] = useState<LinkData | undefined>(undefined);

  useEffect(() => {
    if (!href) return;

    (async () => {
      try {
        setLoading(true);
        const result = await editor.storage.getLinkData?.(href);
        setLinkData(result);
        setLoading(false);
      } catch (e) {
        setLoading(false);
      }
    })();
  }, [href]);

  if (!link || !href) return null;

  const title = linkData?.title || href;

  return (
    <Flex sx={{ alignItems: "center" }}>
      {linkData?.type && (
        <LinkTypeIcon type={linkData.type} metadata={linkData.metadata} />
      )}
      {loading ? (
        <Text sx={{ fontSize: "subBody" }}>{strings.loading()}</Text>
      ) : (
        <Link
          href={href}
          onClick={(e) => {
            e.preventDefault();
            editor.storage.openLink?.(href);
            hide();
          }}
          target="_blank"
          variant="body"
          sx={{
            fontSize: "subBody",
            fontFamily: "body",
            mr: 4,
            color: "accent",
            maxWidth: [150, 250],
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            ":visited": { color: "accent" },
            ":hover": { color: "accent", opacity: 0.8 }
          }}
        >
          {title}
        </Link>
      )}
      <ToolButton
        icon={props.icon}
        title={props.title}
        toggled={false}
        onClick={() => {
          editor.storage.openLink?.(href);
          hide();
        }}
      />
    </Flex>
  );
}

export function CopyLink(props: ToolProps) {
  const { editor } = props;
  const { selectedNode: _selectedNode, hide } = useHoverPopupContext();
  const selectedNode = useRefValue(
    _selectedNode || selectionToOffset(editor.state)
  );
  const { node } = selectedNode.current || {};
  const link = node ? findMark(node, "link") : null;
  if (!link) return null;
  const href = link?.attrs.href;
  if (!href) return null;

  return (
    <ToolButton
      {...props}
      toggled={false}
      onClick={async () => {
        const linkData = await editor.storage.getLinkData?.(href);
        if (linkData?.title) {
          editor.storage.copyToClipboard?.(
            href,
            `<a href="${href}">${linkData.title}</a>`
          );
        } else {
          editor.storage.copyToClipboard?.(href);
        }
        hide();
      }}
    />
  );
}

export type LinkDefinition = {
  href: string;
  title?: string;
};
type LinkToolProps = ToolProps & {
  isEditing?: boolean;
  onDone: (link: LinkDefinition) => void;
  onClick: () => LinkDefinition | undefined;
};
function LinkTool(props: LinkToolProps) {
  const { isEditing, onClick, onDone, editor, ...toolProps } = props;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  const [linkDefinition, setLinkDefinition] = useState<LinkDefinition>();
  const isImageActive = editor.isActive(ImageNode.name);

  return (
    <>
      <ToolButton
        {...toolProps}
        buttonRef={buttonRef}
        onClick={() => {
          const result = onClick();
          if (!result) return;
          setLinkDefinition(result);
          setIsOpen(true);
        }}
        toggled={isOpen}
      />
      <ResponsivePresenter
        mobile="sheet"
        desktop="popup"
        position={{
          target: buttonRef.current || undefined,
          isTargetAbsolute: true,
          location: "below",
          align: "center",
          yOffset: 5
        }}
        title={isEditing ? strings.editLink() : strings.insertLink()}
        isOpen={isOpen}
        items={[]}
        onClose={() => {
          setIsOpen(false);
          editor.commands.focus();
        }}
        focusOnRender={false}
      >
        <LinkPopup
          link={linkDefinition}
          isEditing={isEditing}
          isImageActive={isImageActive}
          onClose={() => setIsOpen(false)}
          onDone={(link) => {
            onDone(link);
            setIsOpen(false);
          }}
        />
      </ResponsivePresenter>
    </>
  );
}

const LINK_TYPE_ICONS: Record<LinkData["type"], string> = {
  note: mdiNoteOutline,
  notebook: mdiBookOutline,
  tag: mdiPound,
  color: Icons.circle
};

function LinkTypeIcon({
  type,
  metadata
}: {
  type: LinkData["type"];
  metadata?: LinkData["metadata"];
}) {
  const path = LINK_TYPE_ICONS[type];
  if (!path) return null;

  const color =
    type === "color" && metadata?.colorCode
      ? metadata.colorCode
      : "icon-secondary";

  return <Icon path={path} color={color} size={13} sx={{ mr: 1 }} />;
}

export function isInternalLink(href?: string | null) {
  // Mirrors the protocol aliases accepted by the core internal-link parser
  // (`packages/core/src/utils/internal-link.ts`): both `nn://` and `veyran://`,
  // case-insensitive. The editor package must not depend on `@notesnook/core`,
  // so the existing pattern is reused directly instead of adding a dependency.
  return typeof href === "string" ? /^(?:nn|veyran):\/\//i.test(href) : false;
}

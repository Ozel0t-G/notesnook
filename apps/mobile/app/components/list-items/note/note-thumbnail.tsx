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

import type { NoteThumbnail as NoteThumbnailInfo } from "@notesnook/common";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Image, View } from "react-native";
import { useNoteThumbnail } from "../../../hooks/use-note-thumbnail";
import { NOTE_THUMBNAIL_SIZE } from "../../../utils/note-thumbnail";

type NoteThumbnailProps = {
  noteId?: string;
  thumbnail?: NoteThumbnailInfo;
  /** Resolved vault membership of the note (true even while unlocked). */
  locked?: boolean;
  /** When false the thumbnail is not rendered/loaded (e.g. trash rows). */
  enabled?: boolean;
  size?: number;
};

/**
 * The trailing 52 pt image shown on Apple (iPhone/iPad/Mac Catalyst) note-list
 * rows. It renders nothing when the note has no raster image, when it is in a
 * locked vault, or while the image is still being downloaded/decrypted.
 *
 * Only the visible row mounts this component (the list is virtualized), so only
 * visible notes ever download or decrypt an image. When the row is recycled to
 * a different note the hook resets and reloads, so a stale image is never shown
 * for the wrong note.
 */
export function NoteThumbnail({
  noteId,
  thumbnail,
  locked,
  enabled = true,
  size = NOTE_THUMBNAIL_SIZE
}: NoteThumbnailProps) {
  const { colors } = useThemeColors();
  const uri = useNoteThumbnail({ noteId, thumbnail, locked, enabled });

  // No image yet (or none at all): render nothing rather than an empty box so
  // rows without images keep their full width for the title.
  if (!enabled || !thumbnail || !uri) return null;

  return (
    <View
      testID="note-thumbnail"
      style={{
        width: size,
        height: size,
        marginLeft: 8,
        borderRadius: 6,
        overflow: "hidden",
        backgroundColor: colors.secondary.background
      }}
    >
      <Image
        source={{ uri }}
        style={{ width: size, height: size }}
        resizeMode="cover"
        accessible={false}
      />
    </View>
  );
}

export default NoteThumbnail;

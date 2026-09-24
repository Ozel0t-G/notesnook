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

import MDIIcon from "@mdi/react";
import {
  mdiAirplane,
  mdiBellOutline,
  mdiBookOpenOutline,
  mdiBriefcaseOutline,
  mdiCameraOutline,
  mdiCarOutline,
  mdiCartOutline,
  mdiCheckAll,
  mdiCreditCardOutline,
  mdiDumbbell,
  mdiFolderOutline,
  mdiFormatListBulleted,
  mdiGamepadVariantOutline,
  mdiGiftOutline,
  mdiHammer,
  mdiHeartOutline,
  mdiHomeOutline,
  mdiLaptop,
  mdiLeaf,
  mdiMusicNote,
  mdiPaletteOutline,
  mdiPawOutline,
  mdiPill,
  mdiSchoolOutline,
  mdiSilverwareForkKnife,
  mdiStarOutline,
  mdiWalk,
  mdiWrench,
  mdiAccountOutline,
  mdiAccountMultipleOutline
} from "@mdi/js";

const paths: Record<string, string> = {
  "list.bullet": mdiFormatListBulleted,
  briefcase: mdiBriefcaseOutline,
  house: mdiHomeOutline,
  cart: mdiCartOutline,
  graduationcap: mdiSchoolOutline,
  heart: mdiHeartOutline,
  car: mdiCarOutline,
  airplane: mdiAirplane,
  gamecontroller: mdiGamepadVariantOutline,
  "fork.knife": mdiSilverwareForkKnife,
  pills: mdiPill,
  dumbbell: mdiDumbbell,
  book: mdiBookOpenOutline,
  laptopcomputer: mdiLaptop,
  hammer: mdiHammer,
  wrench: mdiWrench,
  person: mdiAccountOutline,
  "person.2": mdiAccountMultipleOutline,
  pawprint: mdiPawOutline,
  gift: mdiGiftOutline,
  "music.note": mdiMusicNote,
  camera: mdiCameraOutline,
  leaf: mdiLeaf,
  star: mdiStarOutline,
  bell: mdiBellOutline,
  paintbrush: mdiPaletteOutline,
  "figure.walk": mdiWalk,
  creditcard: mdiCreditCardOutline,
  folder: mdiFolderOutline,
  checklist: mdiCheckAll
};

const palette: Record<string, string> = {
  red: "#ff453a",
  orange: "#ff9f0a",
  yellow: "#ffd60a",
  green: "#30d158",
  mint: "#63e6be",
  teal: "#40c8c8",
  cyan: "#64d2ff",
  blue: "#0a84ff",
  indigo: "#5e5ce6",
  purple: "#bf5af2",
  pink: "#ff375f",
  brown: "#ac8e68",
  gray: "#98989d"
};

export function taskListColorValue(color?: string): string {
  if (color && Object.hasOwn(palette, color)) return palette[color];
  if (color && /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(color))
    return color;
  return palette.blue;
}

/** Browser renderer equivalent for SF Symbol metadata saved by the iOS client. */
export function TaskListGlyph(props: {
  symbol?: string;
  color?: string;
  size?: number;
}) {
  return (
    <MDIIcon
      path={paths[props.symbol || ""] || mdiFormatListBulleted}
      size={(props.size || 24) / 24}
      color={taskListColorValue(props.color)}
      aria-hidden="true"
    />
  );
}

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
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_THEMES = ["default-light", "default-dark"];

const THEMES_DIRECTORY = path.resolve(
  path.join(__dirname, "..", "src", "theme-engine", "themes")
);

async function main() {
  for (const themeId of DEFAULT_THEMES) {
    const themePath = path.join(THEMES_DIRECTORY, `${themeId}.json`);
    // These upstream themes remain selectable for existing users. Their
    // GPL-licensed JSON and CSS are committed with their original metadata,
    // so a clean VeyraN build never needs to download them from upstream.
    const theme = JSON.parse(await readFile(themePath, "utf8"));
    if (
      theme.id !== themeId ||
      theme.compatibilityVersion !== 1 ||
      theme.license !== "GPL-3.0-or-later" ||
      !theme.scopes ||
      !theme.codeBlockCSS
    ) {
      throw new Error(`Invalid bundled theme: ${themeId}`);
    }
  }
}

await main();

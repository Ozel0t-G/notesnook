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

/**
 * Pure limits/format module.
 *
 * This file deliberately imports nothing: it is the single source of truth for
 * the bounded Connect limits and the accepted content formats, so that pure
 * modules (`schema.ts`, `grants.ts`, `protocol.ts`) can import them without
 * transitively pulling in the content pipeline (showdown, dompurify, DOM,
 * database, crypto). `content.ts` re-exports these bindings unchanged.
 */

export type ConnectContentFormat = "markdown" | "plaintext" | "tiptap";

export const CONTENT_LIMITS = {
  /** Largest accepted request body. */
  maxContentChars: 100_000,
  maxTitleChars: 512,
  maxQueryChars: 512,
  maxIdChars: 200,
  /**
   * Largest note body the adapter will return. A larger stored body fails
   * closed (`CONTENT_TOO_LARGE`) instead of being silently truncated.
   */
  maxResponseContentChars: 1_000_000,
  /** Largest returned summary title; longer titles are cut and flagged. */
  maxResponseTitleChars: 4_096,
  /** Hard cap for every returned collection. */
  maxResponseItems: 200,
  defaultSearchResults: 20,
  maxSearchResults: 50,
  maxGrantIds: 1_000
} as const;

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
 * Bookkeeping for the Mac Search section's recent terms. Kept free of React
 * and storage so the list logic can be unit tested; the global search store
 * owns the state and persists it (see stores/use-global-search-store.ts).
 */

/** The most recent terms kept, newest first. */
export const MAX_RECENT_SEARCHES = 8;

/**
 * `list` with `query` moved to the front, de-duplicated case-insensitively
 * and capped at `max`. An empty query leaves the list untouched (same
 * reference, so callers can skip persisting it).
 */
export function addRecentSearch(
  list: string[],
  query: string,
  max = MAX_RECENT_SEARCHES
): string[] {
  const term = query.trim();
  if (!term) return list;
  const lower = term.toLocaleLowerCase();
  const next = [
    term,
    ...list.filter((item) => item.toLocaleLowerCase() !== lower)
  ];
  return next.length > max ? next.slice(0, max) : next;
}

/**
 * Whatever storage holds may not be a clean list (older builds, manual edits,
 * a corrupt entry), so only keep non-empty strings, de-duplicated and capped.
 */
export function sanitizeRecentSearches(
  value: unknown,
  max = MAX_RECENT_SEARCHES
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.trim();
    if (!term) continue;
    const lower = term.toLocaleLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(term);
    if (terms.length === max) break;
  }
  return terms;
}

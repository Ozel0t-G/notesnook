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
 * Pure helpers for the template picker. Kept free of React Native imports so
 * they stay unit-testable.
 */

const PREVIEW_MAX_LENGTH = 120;

export function filterTemplates<T extends { title?: string }>(
  templates: T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return templates;
  return templates.filter((template) =>
    (template.title || "").toLowerCase().includes(normalized)
  );
}

export function shouldAdoptTemplateTitle(currentTitle?: string): boolean {
  return !currentTitle || currentTitle.trim().length === 0;
}

export function templatePreview(headline?: string): string {
  if (!headline) return "";
  const singleLine = headline.replace(/\s+/g, " ").trim();
  return singleLine.length > PREVIEW_MAX_LENGTH
    ? `${singleLine.slice(0, PREVIEW_MAX_LENGTH - 1)}…`
    : singleLine;
}

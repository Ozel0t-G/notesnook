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
 * Pure helpers for note templates. Kept free of database/React Native imports
 * so the HTML rewriting stays unit-testable.
 */

export type TemplateContext = {
  now: Date;
  title: string;
  locale?: string;
};

const VARIABLE_REGEX = /\{\{\s*(date|time|title)\s*\}\}/g;
const LI_TAG_REGEX = /<li\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTRIBUTE_REGEX = /([^\s=/>]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const CLASS_VALUE_REGEX = /=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function formatDate(now: Date, locale?: string): string {
  return now.toLocaleDateString(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
}

function formatTime(now: Date, locale?: string): string {
  return now.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function variableValues(ctx: TemplateContext): Record<string, string> {
  return {
    date: escapeHtml(formatDate(ctx.now, ctx.locale)),
    time: escapeHtml(formatTime(ctx.now, ctx.locale)),
    title: escapeHtml(ctx.title)
  };
}

function replaceVariables(
  text: string,
  values: Record<string, string>
): string {
  return text.replace(VARIABLE_REGEX, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
  );
}

/**
 * Variables are only substituted in text nodes. Attributes (and the tags
 * themselves) are copied verbatim so a template cannot inject values into an
 * href/src. Unknown `{{name}}` placeholders stay as written.
 */
export function applyTemplateVariables(
  html: string,
  ctx: TemplateContext
): string {
  const values = variableValues(ctx);
  let output = "";
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart === -1) {
      output += replaceVariables(html.slice(index), values);
      break;
    }

    output += replaceVariables(html.slice(index, tagStart), values);
    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd === -1) {
      // Unclosed tag: keep the remainder untouched rather than risk mangling it.
      output += html.slice(tagStart);
      break;
    }
    output += html.slice(tagStart, tagEnd + 1);
    index = tagEnd + 1;
  }

  return output;
}

/** Finds the closing `>` of a tag, skipping quoted attribute values. */
function findTagEnd(html: string, start: number): number {
  if (html.startsWith("<!--", start)) {
    const commentEnd = html.indexOf("-->", start + 4);
    return commentEnd === -1 ? -1 : commentEnd + 2;
  }

  let quote: string | undefined;
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Unchecks every task list item. Stored task items are
 * `<li class="checklist--item checked">` (see task-item extension), checked
 * state is only that class. `checked`/`data-checked` attributes are also
 * removed in case a document was imported from another editor.
 */
export function resetTaskChecks(html: string): string {
  return html.replace(LI_TAG_REGEX, (tag) => resetTaskItemTag(tag));
}

function resetTaskItemTag(tag: string): string {
  const name = /^<li\b/i.exec(tag);
  if (!name) return tag;

  const selfClosing = /\/>$/.test(tag);
  const attributes = tag.slice(name[0].length, selfClosing ? -2 : -1);
  const kept: string[] = [];
  let hasCheckedAttribute = false;
  let isTaskItem = false;
  let match: RegExpExecArray | null;

  ATTRIBUTE_REGEX.lastIndex = 0;
  while ((match = ATTRIBUTE_REGEX.exec(attributes))) {
    const attribute = match[1];
    const lower = attribute.toLowerCase();
    if (lower === "checked" || lower === "data-checked") {
      hasCheckedAttribute = true;
      continue;
    }
    if (lower === "class") {
      const classValue = CLASS_VALUE_REGEX.exec(match[2] || "");
      const classes = (
        classValue?.[1] ??
        classValue?.[2] ??
        classValue?.[3] ??
        ""
      )
        .split(/\s+/)
        .filter(Boolean);
      if (classes.includes("checklist--item")) isTaskItem = true;
      const remaining = classes.filter((name) => name !== "checked");
      if (remaining.length === 0) continue;
      const quote = match[2]?.includes("'") ? "'" : '"';
      kept.push(`class=${quote}${remaining.join(" ")}${quote}`);
      continue;
    }
    kept.push(match[0]);
  }

  // Untouched tags (simple checklists, plain lists) must round-trip exactly.
  if (!isTaskItem && !hasCheckedAttribute) return tag;

  return `<li${kept.length > 0 ? ` ${kept.join(" ")}` : ""}>`;
}

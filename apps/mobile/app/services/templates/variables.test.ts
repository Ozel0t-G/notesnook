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

import {
  applyTemplateVariables,
  escapeHtml,
  resetTaskChecks,
  TemplateContext
} from "./variables";

const NOW = new Date(2026, 8, 30, 14, 5, 0);
const LOCALE = "en-US";

function context(title = "My title"): TemplateContext {
  return { now: NOW, title, locale: LOCALE };
}

function expectedDate() {
  return NOW.toLocaleDateString(LOCALE, {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
}

function expectedTime() {
  return NOW.toLocaleTimeString(LOCALE, {
    hour: "numeric",
    minute: "2-digit"
  });
}

describe("escapeHtml", () => {
  test("escapes all html control characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
    );
  });

  test("leaves regular text untouched", () => {
    expect(escapeHtml("Tom & Jerry's 50%")).toBe("Tom &amp; Jerry&#39;s 50%");
  });
});

describe("applyTemplateVariables", () => {
  test("replaces date, time and title in text nodes", () => {
    const html = "<p>{{date}} {{time}} - {{title}}</p>";
    expect(applyTemplateVariables(html, context("Meeting"))).toBe(
      `<p>${expectedDate()} ${expectedTime()} - Meeting</p>`
    );
  });

  test("replaces multiple occurrences", () => {
    const html = "<p>{{title}} and {{title}}</p>";
    expect(applyTemplateVariables(html, context("A"))).toBe("<p>A and A</p>");
  });

  test("tolerates inner whitespace inside placeholders", () => {
    expect(applyTemplateVariables("<p>{{ title }}</p>", context("A"))).toBe(
      "<p>A</p>"
    );
  });

  test("never touches attributes or the tag itself", () => {
    const html =
      '<a href="{{title}}" data-date="{{date}}" title="{{title}}">{{title}}</a>';
    expect(applyTemplateVariables(html, context("A"))).toBe(
      '<a href="{{title}}" data-date="{{date}}" title="{{title}}">A</a>'
    );
  });

  test("ignores `>` inside a quoted attribute", () => {
    const html = '<img alt="a > b {{title}}">x {{title}}';
    expect(applyTemplateVariables(html, context("A"))).toBe(
      '<img alt="a > b {{title}}">x A'
    );
  });

  test("leaves unknown variables unchanged", () => {
    const html = "<p>{{author}} {{unknown}} {{title}}</p>";
    expect(applyTemplateVariables(html, context("A"))).toBe(
      "<p>{{author}} {{unknown}} A</p>"
    );
  });

  test("does not treat `{{` inside an attribute as a variable", () => {
    const html = '<p data-x="prefix {{title}}"></p>';
    expect(applyTemplateVariables(html, context("A"))).toBe(html);
  });

  test("escapes the inserted title", () => {
    const html = "<p>{{title}}</p>";
    expect(applyTemplateVariables(html, context(`<b>&"'`))).toBe(
      "<p>&lt;b&gt;&amp;&quot;&#39;</p>"
    );
  });

  test("escapes variables inside comments too (comments stay comments)", () => {
    const html = "<!-- {{title}} --><p>{{title}}</p>";
    expect(applyTemplateVariables(html, context("A"))).toBe(
      "<!-- {{title}} --><p>A</p>"
    );
  });

  test("keeps text containing `>` outside tags intact", () => {
    const html = "<p>a > b {{title}}</p>";
    expect(applyTemplateVariables(html, context("A"))).toBe("<p>a > b A</p>");
  });

  test("an unclosed tag does not swallow the rest unpredictably", () => {
    const html = "<p>{{title}}</p><div";
    expect(applyTemplateVariables(html, context("A"))).toBe("<p>A</p><div");
  });
});

describe("resetTaskChecks", () => {
  test("unchecks every task item", () => {
    const html =
      '<ul class="checklist"><li class="checklist--item checked"><p>a</p></li><li class="checklist--item"><p>b</p></li><li class="checklist--item checked"><p>c</p></li></ul>';
    expect(resetTaskChecks(html)).toBe(
      '<ul class="checklist"><li class="checklist--item"><p>a</p></li><li class="checklist--item"><p>b</p></li><li class="checklist--item"><p>c</p></li></ul>'
    );
  });

  test("keeps other task item attributes", () => {
    const html =
      '<li class="checklist--item checked" data-block-id="x" data-spacing="double">a</li>';
    expect(resetTaskChecks(html)).toBe(
      '<li class="checklist--item" data-block-id="x" data-spacing="double">a</li>'
    );
  });

  test("removes checked from any position in the class list", () => {
    expect(resetTaskChecks('<li class="checked checklist--item">a</li>')).toBe(
      '<li class="checklist--item">a</li>'
    );
  });

  test("supports single quoted attributes", () => {
    expect(resetTaskChecks("<li class='checklist--item checked'>a</li>")).toBe(
      "<li class='checklist--item'>a</li>"
    );
  });

  test("drops checked/data-checked attributes", () => {
    expect(resetTaskChecks('<li data-checked="true">a</li>')).toBe(
      "<li>a</li>"
    );
    expect(
      resetTaskChecks('<li checked="true" class="checklist--item">a</li>')
    ).toBe('<li class="checklist--item">a</li>');
  });

  test("leaves simple checklists and plain list items alone", () => {
    const html =
      '<li class="simple-checklist--item checked">a</li><li class="foo">b</li><li>c</li>';
    expect(resetTaskChecks(html)).toBe(html);
  });

  test("does not touch the word checked in text", () => {
    const html = "<p>checked</p>";
    expect(resetTaskChecks(html)).toBe(html);
  });

  test("returns html without list items unchanged", () => {
    const html = "<p>{{title}}</p>";
    expect(resetTaskChecks(html)).toBe(html);
  });
});

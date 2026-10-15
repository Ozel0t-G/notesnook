from pathlib import Path
p=Path('/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-a-mac/outputs/a12-upper-list-tools/proposal/packages/editor/src/toolbar/__tests__/mac-format-menu.test.tsx')
s=p.read_text().replace('import StarterKit from "@tiptap/starter-kit";','''import StarterKit from "@tiptap/starter-kit";
import { BulletList } from "../../extensions/bullet-list/index.js";
import { OrderedList } from "../../extensions/ordered-list/index.js";
import CheckList from "../../extensions/check-list/index.js";
import CheckListItem from "../../extensions/check-list-item/index.js";''')
s=s.replace('import { useToolbarStore } from "../stores/toolbar-store.js";', '''import { PopupParentContext, useToolbarStore } from "../stores/toolbar-store.js";''')
s=s.replace('extensions: [StarterKit, TextStyle, FontFamily, Color, Highlight, Link],','''extensions: [
      StarterKit.configure({ bulletList: false, orderedList: false }),
      BulletList, OrderedList, CheckList, CheckListItem.configure({ nested: true }),
      TextStyle, FontFamily, Color, Highlight, Link
    ],''')
s=s.replace('    isMobile: true,\n    openedPopups:', '    isMobile: true,\n    toolbarLocation: "bottom",\n    openedPopups:').replace('    isMobile: false,\n    openedPopups:', '    isMobile: false,\n    toolbarLocation: "top",\n    openedPopups:')
s+='''

function listButton(id: string, container: ParentNode = requireElement(host())) {
  return requireElement(container.querySelector<HTMLButtonElement>(`button[id$="${id}"]`));
}
function styleChoices() {
  return [...owner.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.querySelector("ul > li"));
}

test.each([
  ["bulletList", "bulletList", "square", 2, 3],
  ["numberedList", "orderedList", "upper-roman", 3, 6]
] as const)("Mac upper lists apply genuine %s style, preserve selection and owned child-first Escape", (tool, node, style, index, count) => {
  setup();
  act(() => editor.commands.setTextSelection({ from: 1, to: 6 }));
  open();
  const token = requireElement(host()) && getPopupDismissToken(owner);
  const trigger = listButton(`${tool}-palette`);
  const anchor = requireElement(trigger.parentElement);
  const anchorRect = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(90, 140, 60, 28));
  const lower = document.createElement("div");
  lower.className = "editor-toolbar";
  tab.append(lower);
  const lowerRect = vi.spyOn(lower, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 700, 600, 40));
  act(() => trigger.click());
  const child = Object.values(useToolbarStore.getState().openedPopups).find((popup) => popup && popup.id.endsWith(`:${tool}`));
  expect(child && child.parent).toMatch(/^mac-native-format-/);
  expect(child && child.id).toMatch(/^mac-native-format-\\d+:/);
  expect(anchorRect).toHaveBeenCalled();
  expect(lowerRect).not.toHaveBeenCalled();
  expect(styleChoices()).toHaveLength(count);
  act(() => requireElement(styleChoices()[index]).click());
  expect(editor.isActive(node, { listType: style })).toBe(true);
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe("Alpha");
  expect(child && useToolbarStore.getState().openedPopups[child.id]).toBeUndefined();
  expect(host()).not.toBeNull();
  act(() => trigger.click());
  act(() => { expect(dismissPopupForOwner(owner, Number(token))).toBe(true); });
  expect(host()).not.toBeNull();
  expect(styleChoices()).toHaveLength(0);
  act(() => { expect(dismissPopupForOwner(owner, Number(token))).toBe(true); });
  expect(host()).toBeNull();
  vi.restoreAllMocks();
});

test.each(["bottom", "top"] as const)("Mac upper lists refresh active indent/outdent and run real transactions at %s", (toolbarLocation) => {
  setup();
  useToolbarStore.setState({ toolbarLocation });
  open();
  expect(host()?.querySelector('button[id$="indent"]')).toBeNull();
  act(() => editor.commands.setContent("<p>First</p><p>Second</p>"));
  act(() => editor.commands.setTextSelection({ from: 1, to: 13 }));
  act(() => listButton("bulletList").click());
  expect(editor.isActive("bulletList")).toBe(true);
  act(() => editor.commands.setTextSelection(12));
  const flat = editor.getJSON();
  expect(editor.state.selection.$from.depth).toBe(3);
  act(() => listButton("indent").click());
  expect(editor.state.selection.$from.depth).toBe(5);
  expect(editor.getHTML()).toContain("<li><p>First</p><ul>");
  act(() => listButton("outdent").click());
  expect(editor.getJSON()).toEqual(flat);
  expect(editor.state.selection.$from.depth).toBe(3);
  expect(host()).not.toBeNull();
  act(() => editor.commands.undo());
  expect(host()).not.toBeNull();
});

test("Mac upper checklist uses the existing genuine checklist transaction", () => {
  setup();
  open();
  act(() => listButton("checklist").click());
  expect(editor.isActive("checkList")).toBe(true);
  expect(editor.getHTML()).toContain('class="simple-checklist"');
  expect(editor.getText()).toBe("Alpha Bravo");
  act(() => listButton("checklist").click());
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});

test.each([
  { mac: true, touch: false, presentation: undefined },
  { mac: true, touch: true, presentation: "mac" as const },
  { mac: false, touch: false, presentation: "mac" as const }
])("upper list presentation stays absent for default/touch/non-Mac $mac/$touch/$presentation", ({ mac, touch, presentation }) => {
  const tools = setup();
  useToolbarStore.setState({ macCatalyst: mac });
  act(() => custom.render(<ThemeProvider theme={theme}>
    <AdvancedFormattingSections editor={editor as Editor} groupId="negative" touch={touch} presentation={presentation} />
  </ThemeProvider>));
  for (const id of ["checklist", "bulletList", "numberedList", "indent", "outdent"]) {
    expect(tools.querySelector(`button[id$="${id}"]`)).toBeNull();
  }
  expect(tools.querySelector('button[id$="strikethrough"]')).not.toBeNull();
  expect(editor.getHTML()).toBe("<p>Alpha Bravo</p>");
});

test.each([false, true])("existing bottom list popup keeps root anchor or nested owned anchor (nested=%s)", (nested) => {
  const tools = setup();
  useToolbarStore.setState({ macCatalyst: false });
  tools.className = "editor-toolbar";
  if (nested) useToolbarStore.getState().openPopup({ id: "existing-more", group: "mobile" });
  act(() => custom.render(<ThemeProvider theme={theme}>
    <PopupParentContext.Provider value={nested ? "existing-more" : undefined}>
      <ToolbarGroup editor={editor as Editor} groupId="existing" tools={["bulletList"]} />
    </PopupParentContext.Provider>
  </ThemeProvider>));
  const primary = listButton("bulletList", tools);
  const anchor = requireElement(primary.parentElement);
  const anchorRect = vi.spyOn(anchor, "getBoundingClientRect");
  const lowerRect = vi.spyOn(tools, "getBoundingClientRect");
  const trigger = requireElement(tools.querySelector<HTMLButtonElement>('button[id$="chevronUp"]'));
  act(() => trigger.click());
  const child = useToolbarStore.getState().openedPopups.bulletList;
  expect(child && child.parent).toBe(nested ? "existing-more" : undefined);
  expect(nested ? anchorRect : lowerRect).toHaveBeenCalled();
  expect(nested ? lowerRect : anchorRect).not.toHaveBeenCalled();
  act(() => requireElement(styleChoices()[1]).click());
  expect(editor.isActive("bulletList", { listType: "circle" })).toBe(true);
  expect(useToolbarStore.getState().openedPopups.bulletList).toBeUndefined();
  if (nested) expect(useToolbarStore.getState().openedPopups["existing-more"]).toBeTruthy();
  vi.restoreAllMocks();
});
'''
p.write_text(s)

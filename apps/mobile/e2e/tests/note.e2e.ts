import { notesnook } from "../test.ids";
import { TestBuilder, Tests } from "./utils";
import { expect as detoxExpect } from "detox";
import { expect as jestExpect } from "@jest/globals";

describe("NOTE TESTS", () => {
  it("Create a note in editor", async () => {
    await TestBuilder.create().prepare().createNote().run();
  });

  it("keeps the editor visible when a saved note is reopened", async () => {
    const body = "Editor regression content survives reopen";
    await TestBuilder.create()
      .prepare()
      .createNote(undefined, body)
      .waitAndTapByText(body)
      .addStep(async () => {
        await Tests.waitForEditor();
        const editor = web().element(by.web.className("ProseMirror"));
        await detoxExpect(editor).toExist();
        jestExpect(await editor.getText()).toContain(body);
      })
      .exitEditor()
      .waitAndTapByText(body)
      .addStep(async () => {
        await Tests.waitForEditor();
        const editor = web().element(by.web.className("ProseMirror"));
        await detoxExpect(editor).toExist();
        jestExpect(await editor.getText()).toContain(body);
      })
      .run();
  });

  it("retains an edit to an existing note after save and reopen", async () => {
    const original = "Existing note before edit";
    const addition = "Existing note edit survives reopen";
    await TestBuilder.create().prepare().createNote(undefined, original).run();
    const savedRow = element(by.id("note-item-0"));
    await waitFor(savedRow).toBeVisible().withTimeout(15000);
    await savedRow.tap();
    await Tests.waitForEditor();
    const editor = web().element(by.web.className("ProseMirror"));
    await editor.focus();
    await editor.typeText(addition, true);
    await Tests.exitEditor();
    await waitFor(savedRow).toBeVisible().withTimeout(15000);
    await savedRow.tap();
    await Tests.waitForEditor();
    jestExpect(
      await web().element(by.web.className("ProseMirror")).getText()
    ).toContain(addition);
  });

  it("Open and close a note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.ids.note.get(0))
      .exitEditor()
      .run();
  });

  it("Note history is created", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Test note", "This is a test note")
      .waitAndTapById(notesnook.listitem.menu)
      .wait()
      .waitAndTapById("icon-history")
      .isNotVisibleByText("No note history available for this device.")
      .run();
  });

  it("Duplicate note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Test note", "This is a test note")
      .waitAndTapById(notesnook.listitem.menu)
      .wait()
      .waitAndTapById("icon-duplicate")
      .isVisibleByText("Test note (Copy)")
      .run();
  });

  it("Archive a note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Test note")
      .saveResult()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-archive")
      .pressBack()
      .navigate("Archive")
      .isVisibleByText("Test note")
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-archive")
      .pressBack()
      .isNotVisibleByText("Test note")
      .navigate("Notes")
      .isVisibleByText("Test note")
      .run();
  });

  it("Notes properties should show", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .isVisibleByText("Created at")
      .run();
  });

  it("Favorite and unfavorite a note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .saveResult()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-favorite")
      .pressBack()
      .isVisibleById("icon-star")
      .navigate("Favorites")
      .processResult(async (note) => {
        await TestBuilder.create()
          .isVisibleByText(note.body)
          .waitAndTapById(notesnook.listitem.menu)
          .wait(500)
          .waitAndTapById("icon-favorite")
          .pressBack()
          .isNotVisibleByText(note.body)
          .navigate("Notes")
          .run();
      })
      .run();
  });

  it("Pin a note to top", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-pin")
      .pressBack()
      .isVisibleByText("PINNED")
      .isVisibleById("icon-pinned")
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-pin")
      .pressBack()
      .isNotVisibleByText("icon-pinned")
      .run();
  });

  it.skip("Pin a note in notifications", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.listitem.menu)
      .waitAndTapById("icon-pin-to-notifications")
      .isVisibleByText("Unpin from notifications")
      .waitAndTapById("icon-pin-to-notifications")
      .isVisibleByText("Pin to notifications")
      .run();
  });

  it("Copy note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .isVisibleById("icon-copy")
      .waitAndTapById("icon-copy")
      .run();
  });

  it("Assign colors to a note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .saveResult()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapByText("Add color")
      .typeTextById("color-title-input", "Test color")
      .waitAndTapByText("Add color")
      .isVisibleById("icon-check")
      .waitAndTapById("icon-color-#efefef")
      .isNotVisibleById("icon-check")
      .waitAndTapById("icon-color-#efefef")
      .pressBack()
      .navigate("Test color")
      .processResult(async (note) => {
        await TestBuilder.create().isVisibleByText(note.body).run();
      })
      .run();
  });

  it("Delete & restore a note", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote()
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapById("icon-trash")
      .navigate("Trash")
      .waitAndTapById(notesnook.listitem.menu)
      .wait(500)
      .waitAndTapByText("Restore")
      .pressBack()
      .isVisibleByText(
        "Test note description that is very long and should not fit in text."
      )
      .run();
  });
});

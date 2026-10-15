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

import { getId } from "../utils/id.js";
import { getContentFromData } from "../content-types/index.js";
import {
  HEADLINE_REGEX,
  NEWLINE_STRIP_REGEX,
  formatTitle
} from "../utils/title-format.js";
import { clone } from "../utils/clone.js";
import { EMPTY_CONTENT } from "./content.js";
import { buildFromTemplate } from "../utils/templates/index.js";
import {
  Note,
  TrashOrItem,
  isTrashItem,
  isDeleted,
  NoteContent
} from "../types.js";
import Database from "../api/index.js";
import { ICollection } from "./collection.js";
import { SQLCollection } from "../database/sql-collection.js";
import { isFalse } from "../database/index.js";
import { logger } from "../logger.js";
import { addItems, deleteItems } from "../utils/array.js";
import { sql } from "@streetwriters/kysely";
import {
  assertDomainWriteLease,
  DomainWriteToken,
  withDomainWrite
} from "../connect/domain-lock.js";

export type ExportOptions = {
  format: "html" | "md" | "txt" | "md-frontmatter";
  contentItem?: NoteContent<false>;
  rawContent?: string;
  disableTemplate?: boolean;
  embedMedia?: boolean;
};

/** A note write payload, or a factory that builds it inside the write lock. */
export type NoteWriteSource =
  | Partial<Note & { content: NoteContent<false>; sessionId: string }>
  | ((
      token: DomainWriteToken
    ) =>
      | Partial<Note & { content: NoteContent<false>; sessionId: string }>
      | Promise<
          Partial<Note & { content: NoteContent<false>; sessionId: string }>
        >);

export class Notes implements ICollection {
  name = "notes";
  cache: { archived: string[] } = { archived: [] };
  /**
   * @internal
   */
  collection: SQLCollection<"notes", TrashOrItem<Note>>;
  totalNotes = 0;
  constructor(private readonly db: Database) {
    this.collection = new SQLCollection(
      db.sql,
      db.transaction,
      "notes",
      db.eventManager,
      db.sanitizer
    );
  }

  async init() {
    await this.collection.init();
    this.totalNotes = await this.collection.count();
    await this.buildCache();
  }

  async buildCache() {
    this.cache.archived = [];
    const archived = await this.archived.ids();
    this.cache.archived = archived;
  }

  /**
   * Ordinary note write (editor autosave, import, vault, sync fallback...).
   * Runs inside the shared domain write lock; callers that already hold it
   * (e.g. the vault) pass their token so the nested write runs inline.
   */
  async add(item: NoteWriteSource, token?: DomainWriteToken): Promise<string> {
    return withDomainWrite(
      this.db,
      (writeToken) => this.addUnsafe(writeToken, item),
      token
    );
  }

  /**
   * Additive guarded write.
   *
   * `item` may be given as a (possibly async) factory. The factory runs inside
   * the shared domain write lock *before* this method computes anything from
   * the item (headline, generated title, `contentChanged`, `dateEdited`), so a
   * caller that must read the stored row to build its write (the Connect
   * adapter's append/update) can fully materialize an immutable input there
   * instead of mutating a half-built item later. `addUnsafe` then never
   * re-reads or re-derives the caller's input.
   *
   * The `guard` callback runs inside the same critical section, immediately
   * before *every* persistence boundary this method owns: the content row (and
   * the relation side effects of the content pipeline), the note row and the
   * note history entry. It must be *read-only* validation (current revision,
   * mutability, fence) and it must be safe to invoke more than once: a guard
   * that throws aborts the remaining writes, so a grant, session or lock change
   * that lands while the pipeline is suspended cannot be followed by a write it
   * should have prevented. Because validation and write are one critical
   * section, an expected-revision/mutability check can no longer be separated
   * from the write by a vault lock, a trash transition or a readonly toggle.
   */
  async addGuarded(
    item: NoteWriteSource,
    guard: (token: DomainWriteToken) => Promise<void>,
    /**
     * Optional lease of an already-held domain critical section. A caller that
     * already holds the lock (and therefore must not call `withDomainWrite`
     * without its token, or it would deadlock) threads its lease here so the
     * guarded write runs inline. Defaults to acquiring the lock itself.
     */
    token?: DomainWriteToken
  ): Promise<string> {
    return withDomainWrite(
      this.db,
      (writeToken) => this.addUnsafe(writeToken, item, guard),
      token
    );
  }

  private async addUnsafe(
    token: DomainWriteToken,
    itemSource: NoteWriteSource,
    guard?: (token: DomainWriteToken) => Promise<void>
  ): Promise<string> {
    // Materialize the caller's input inside the critical section, before any
    // field of it is read by the pipeline below.
    const item =
      typeof itemSource === "function" ? await itemSource(token) : itemSource;

    if (item.remote)
      throw new Error("Please use db.notes.merge to merge remote notes.");

    const id = item.id || getId();
    const isUpdating = item.id && (await this.exists(item.id));

    if (!isUpdating && !item.content && !item.contentId && !item.title)
      throw new Error("Note must have a title or content.");

    await this.db.transaction(async () => {
      let contentId = item.contentId;
      let dateEdited = item.dateEdited;
      let headline = item.headline;
      let headlineTitle = "";
      let contentChanged = false;

      if (item.content && item.content.data && item.content.type) {
        logger.debug("saving content", { id });
        const { type, data } = item.content;

        const content = await getContentFromData(type, data);
        if (!content) throw new Error("Invalid content type.");

        headline = content.toHeadline();
        headlineTitle = content.toTitle();
        dateEdited = Date.now();
        contentChanged = true;
      }

      if (typeof item.title !== "undefined") {
        item.title = item.title.replace(NEWLINE_STRIP_REGEX, " ");
        dateEdited = Date.now();
      }

      if (!isUpdating || item.title === "") {
        item.isGeneratedTitle = !Boolean(item.title);
        item.title =
          item.title ||
          formatTitle(
            this.db.settings.getTitleFormat(),
            this.db.settings.getDateFormat(),
            this.db.settings.getTimeFormat(),
            this.db.settings.getDayFormat(),
            headlineTitle,
            this.totalNotes
          );
      }

      const currentNoteTitleFields = await this.db
        .sql()
        .selectFrom("notes")
        .select(["isGeneratedTitle", "title"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (isUpdating) {
        const didUserEditTitle = Boolean(item.title);
        item.isGeneratedTitle =
          Boolean(currentNoteTitleFields?.isGeneratedTitle) &&
          !didUserEditTitle;
        const titleFormat = this.db.settings.getTitleFormat();
        if (
          item.isGeneratedTitle &&
          HEADLINE_REGEX.test(titleFormat) &&
          headlineTitle &&
          currentNoteTitleFields?.title !== headlineTitle
        ) {
          item.title = titleFormat.replace(HEADLINE_REGEX, headlineTitle);
        } else if (item.title === "")
          item.title = currentNoteTitleFields?.title || "Untitled";
      }

      // ------------------------------------------------------------------
      // Persistence section. Every await that produced an input for this
      // write has completed; the guard (expected revision, mutability, fence)
      // runs here, immediately before the first write, and no lock-taking
      // writer can interleave from here on.
      //
      // A single write spans several persistence boundaries (content row,
      // note row, history) and the content pipeline itself awaits
      // post-processing before it writes; the guard is therefore re-run
      // immediately before *each* of them so a grant/lock/session change that
      // lands during one of those awaits stops the remaining writes instead of
      // being carried through to the end.
      // ------------------------------------------------------------------
      const checkGuard = guard ? () => guard(token) : undefined;
      if (checkGuard) await checkGuard();

      if (contentChanged) {
        contentId = await this.db.content.add(
          {
            noteId: id,
            sessionId: item.sessionId,
            id: contentId,
            dateEdited,
            type: item.content!.type,
            data: item.content!.data,
            ...(item.localOnly !== undefined
              ? { localOnly: item.localOnly }
              : {})
          },
          token,
          checkGuard
        );
      } else if (contentId && item.localOnly !== undefined) {
        if (checkGuard) await checkGuard();
        await this.db.content.add(
          {
            id: contentId,
            localOnly: !!item.localOnly
          },
          token,
          checkGuard
        );
      }

      if (isUpdating) {
        if (checkGuard) await checkGuard();
        await this.collection.update([id], {
          title: item.title,
          headline: headline,
          contentId,

          pinned: item.pinned,
          favorite: item.favorite,
          localOnly: item.localOnly,
          conflicted: item.conflicted,
          readonly: item.readonly,
          archived: item.archived,

          dateCreated: item.dateCreated,
          dateEdited: item.dateEdited || dateEdited,

          isGeneratedTitle: item.isGeneratedTitle
        });
      } else {
        if (checkGuard) await checkGuard();
        await this.collection.upsert({
          id,
          type: "note",
          contentId,

          title: item.title,
          headline: headline,

          pinned: item.pinned,
          favorite: item.favorite,
          localOnly: item.localOnly,
          conflicted: item.conflicted,
          readonly: item.readonly,
          archived: item.archived,

          dateCreated: item.dateCreated || Date.now(),
          dateEdited: item.dateEdited || dateEdited || Date.now(),

          isGeneratedTitle: item.isGeneratedTitle
        });
        this.totalNotes++;
      }

      if (item.sessionId && typeof item.title === "string") {
        if (checkGuard) await checkGuard();
        await this.db.noteHistory.add(item.sessionId, {
          title: item.title,
          noteId: id
        });
      }
    });
    return id;
  }

  async note(id: string) {
    const note = await this.collection.get(id);
    if (!note || isTrashItem(note) || isDeleted(note)) return;
    return note;
  }

  async trashed(id: string) {
    const note = await this.collection.get(id);
    if (note && (!isTrashItem(note) || isDeleted(note))) return;
    return note;
  }

  async tags(id: string) {
    return this.db.relations
      .to({ id, type: "note" }, "tag")
      .selector.items(undefined, {
        sortBy: "dateCreated",
        sortDirection: "asc"
      });
  }

  // note(idOrNote: string | Note) {
  //   if (!idOrNote) return;
  //   const note =
  //     typeof idOrNote === "object" ? idOrNote : this.collection.get(idOrNote);
  //   if (!note || isTrashItem(note)) return;
  //   return createNoteModel(note, this.db);
  // }

  // get raw() {
  //   return this.collection.raw();
  // }

  get all() {
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where(isFalse("archived")),
      this.db.options?.batchSize
    );
  }

  /**
   * All the notes from {@link all} that do not belong to any notebook i.e.
   * the "Inbox". Relations are soft deleted so `relations.deleted` has to be
   * filtered out explicitly, and notebooks sitting in the trash are ignored
   * the same way `db.relations` ignores them.
   */
  get unassigned() {
    const trashedNotebooks = this.db.trash.cache.notebooks;
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where(isFalse("archived"))
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("relations")
                  .select("relations.id")
                  .whereRef("relations.toId", "==", "notes.id")
                  .where("relations.toType", "==", "note")
                  .where("relations.fromType", "==", "notebook")
                  .where(isFalse("relations.deleted"))
                  .$if(trashedNotebooks.length > 0, (b) =>
                    b.where("relations.fromId", "not in", trashedNotebooks)
                  )
              )
            )
          ),
      this.db.options?.batchSize
    );
  }

  get exportable() {
    return this.collection.createFilter<Note>(
      (qb) => qb.where(isFalse("dateDeleted")).where(isFalse("deleted")),
      this.db.options?.batchSize
    );
  }

  // isTrashed(id: string) {
  //   return this.raw.find((item) => item.id === id && isTrashItem(item));
  // }

  // get trashed() {
  //   return this.raw.filter((item) =>
  //     isTrashItem(item)
  //   ) as BaseTrashItem<Note>[];
  // }

  get pinned() {
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where("pinned", "==", true),
      this.db.options?.batchSize
    );
  }

  get conflicted() {
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where("conflicted", "==", true),
      this.db.options?.batchSize
    );
  }

  get favorites() {
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where(isFalse("archived"))
          .where("favorite", "==", true),
      this.db.options?.batchSize
    );
  }

  get archived() {
    return this.collection.createFilter<Note>(
      (qb) =>
        qb
          .where(isFalse("dateDeleted"))
          .where(isFalse("deleted"))
          .where("archived", "==", true),
      this.db.options?.batchSize
    );
  }

  exists(id: string) {
    return this.collection.exists(id);
  }

  /**
   * Move notes to the trash. The transition itself is serialized by
   * `db.trash.add` (shared domain lock), so a guarded Connect write can never
   * observe the note mid-transition.
   */
  moveToTrash(...ids: string[]) {
    return withDomainWrite(this.db, (token) => this._delete(true, token, ids));
  }

  remove(...ids: string[]) {
    return withDomainWrite(this.db, (token) => this._delete(false, token, ids));
  }

  /**
   * Permanent removal for callers that already hold the domain write lock
   * (e.g. `Trash._delete`): deleting a note soft-deletes its content row, so it
   * must not interleave with a guarded content writer.
   *
   * The passed token is validated before the first write: the deletion spans a
   * relation unlink, the note row and the content row, and a stale or foreign
   * token must not be able to run any part of that sequence (the content call
   * would reject it only after the note row was already gone).
   */
  removeLocked(token: DomainWriteToken, ...ids: string[]) {
    assertDomainWriteLease(this.db, token);
    return this._delete(false, token, ids);
  }

  pin(state: boolean, ...ids: string[]) {
    return withDomainWrite(this.db, () =>
      this.collection.update(ids, { pinned: state })
    );
  }
  favorite(state: boolean, ...ids: string[]) {
    return withDomainWrite(this.db, () =>
      this.collection.update(ids, { favorite: state })
    );
  }
  async archive(state: boolean, ...ids: string[]) {
    await withDomainWrite(this.db, () =>
      this.collection.update(ids, { archived: state })
    );
    if (state) {
      addItems(this.cache.archived, ...ids);
    } else {
      deleteItems(this.cache.archived, ...ids);
    }
  }

  async setExpiryDate(date: number | null, ...ids: string[]) {
    await withDomainWrite(this.db, () =>
      this.collection.update(ids, {
        expiryDate: {
          dateModified: Date.now(),
          value: date
        }
      })
    );
  }

  /** Readonly is a mutability gate for note writes, so it shares the lock. */
  readonly(state: boolean, ...ids: string[]) {
    return withDomainWrite(this.db, () =>
      this.collection.update(ids, { readonly: state })
    );
  }
  async localOnly(state: boolean, ...ids: string[]) {
    await withDomainWrite(this.db, async (token) => {
      await this.collection.update(ids, { localOnly: state });
      await this.db.content.updateByNoteIdLocked(
        token,
        { localOnly: state },
        ...ids
      );
    });
  }
  spellcheck(state: boolean, ...ids: string[]) {
    return withDomainWrite(this.db, () =>
      this.collection.update(ids, { spellcheck: state })
    );
  }

  async export(id: string, options: ExportOptions): Promise<false | string>;
  async export(note: Note, options: ExportOptions): Promise<false | string>;
  async export(noteOrId: Note | string, options: ExportOptions) {
    const note =
      typeof noteOrId === "string" ? await this.note(noteOrId) : noteOrId;
    if (!note) return false;

    const { format, rawContent } = options;

    const contentString =
      rawContent === undefined
        ? await (async () => {
            let contentItem = options.contentItem;
            if (!contentItem) {
              const rawContent = await this.db.content.findByNoteId(note.id);
              if (rawContent && rawContent.locked) return false;
              contentItem = rawContent || EMPTY_CONTENT(note.id);
            }

            const { data, type } =
              options?.embedMedia && format !== "txt"
                ? await this.db.content.downloadMedia(
                    `export-${note.id}`,
                    contentItem,
                    false
                  )
                : contentItem;
            const content = await getContentFromData(type, data);
            return format === "html"
              ? content.toHTML()
              : format === "md"
              ? content.toMD()
              : content.toTXT();
          })()
        : rawContent;
    if (contentString === false) return false;

    const tags = (await this.db.relations.to(note, "tag").resolve()).map(
      (tag) => tag.title
    );
    const color = (await this.db.relations.to(note, "color").resolve(1))[0]
      ?.title;

    return options?.disableTemplate
      ? contentString
      : buildFromTemplate(format, {
          ...note,
          tags,
          color,
          content: contentString
        });
  }

  async duplicate(...ids: string[]) {
    for (const id of ids) {
      const note = await this.note(id);
      if (!note) continue;

      const content = note.contentId
        ? await this.db.content.get(note.contentId)
        : undefined;
      const duplicateId = await this.db.notes.add({
        ...clone(note),
        id: undefined,
        pinned: false,
        isGeneratedTitle: false,
        contentId: undefined,
        title: note.title + " (Copy)",
        dateEdited: undefined,
        dateCreated: undefined,
        dateModified: undefined
      });

      const contentId = await this.db.content.add({
        ...clone(content),
        id: undefined,
        noteId: duplicateId,
        dateResolved: undefined,
        dateEdited: undefined,
        dateCreated: undefined,
        dateModified: undefined
      });

      await this.db.notes.add({ id: duplicateId, contentId });

      for (const relation of await this.db.relations.to(note).get()) {
        await this.db.relations.add(
          { type: relation.fromType, id: relation.fromId },
          {
            id: duplicateId,
            type: "note"
          }
        );
      }

      for (const relation of await this.db.relations.from(note).get()) {
        await this.db.relations.add(
          {
            id: duplicateId,
            type: "note"
          },
          { type: relation.toType, id: relation.toId }
        );
      }
    }
  }

  /** Callers must hold the domain write lock (`token`) or be its acquirer. */
  private async _delete(
    moveToTrash: boolean,
    token: DomainWriteToken,
    ids: string[]
  ) {
    if (ids.length <= 0) return;

    if (moveToTrash) {
      await this.db.trash.add("note", ids, "user", token);
    } else {
      // `db.transaction` is a pass-through in this codebase (it opens no real
      // SQL transaction); the domain write lock is what makes the sequence
      // atomic against every other note/content writer.
      await this.db.transaction(async () => {
        // Collect the tags these notes reference before the relations are
        // soft-deleted (they stop being queryable afterwards); a tag that no
        // other note uses should not outlive its last note.
        const tagIds = new Set(
          (await this.db.relations.to({ type: "note", ids }, "tag").get()).map(
            (relation) => relation.fromId
          )
        );
        await this.db.relations.unlinkOfType("note", ids);
        await this.collection.softDelete(ids);
        await this.db.content.removeByNoteIdLocked(token, ...ids);
        await this.db.inboxItemsHistory.delete(ids);
        if (tagIds.size) await this.db.tags.removeIfUnused(...tagIds);
      });
    }

    this.totalNotes = Math.max(0, this.totalNotes - ids.length);
  }

  /**
   * Bind notes to a notebook. Notebook membership is part of how Connect
   * decides authorization (`isNoteAuthorized`), so the relation write shares
   * the domain lock with note content writes.
   */
  async addToNotebook(notebookId: string, ...noteIds: string[]) {
    await withDomainWrite(this.db, async () => {
      for (const noteId of noteIds) {
        await this.db.relations.add(
          { id: notebookId, type: "notebook" },
          { type: "note", id: noteId }
        );
      }
    });
  }

  /**
   * Additive guarded notebook binding for a single note.
   *
   * `addToNotebook` may wait on the shared domain lock for an unbounded time
   * (it is also called by sync and the vault paths); a caller whose permission,
   * session or lock state can be revoked while it waits must not write the
   * relation anyway. `guard` therefore runs *inside* that critical section,
   * after the read that decides whether the binding is missing and immediately
   * before the relation write — with nothing awaited in between — so revocation
   * during the lock wait denies the write instead of racing past it. The
   * already-bound case is a no-op (no write, no guard call).
   *
   * The ordinary `addToNotebook` (editor/UI/sync) keeps its behavior and takes
   * no guard.
   */
  async addToNotebookGuarded(
    notebookId: string,
    noteId: string,
    guard: (token: DomainWriteToken) => Promise<void>,
    /** Optional lease of an already-held critical section (see `addGuarded`). */
    token?: DomainWriteToken
  ): Promise<void> {
    await withDomainWrite(
      this.db,
      async (writeToken) => {
        const existing = await this.db.relations
          .to({ id: noteId, type: "note" }, "notebook")
          .get();
        if (existing.some((relation) => relation.fromId === notebookId)) return;
        await guard(writeToken);
        await this.db.relations.add(
          { id: notebookId, type: "notebook" },
          { type: "note", id: noteId }
        );
      },
      token
    );
  }

  async removeFromNotebook(notebookId: string, ...noteIds: string[]) {
    await withDomainWrite(this.db, async () => {
      for (const noteId of noteIds) {
        await this.db.relations.unlink(
          { id: notebookId, type: "notebook" },
          { type: "note", id: noteId }
        );
      }
    });
  }

  async removeFromAllNotebooks(...noteIds: string[]) {
    await withDomainWrite(this.db, async () => {
      await this.db.relations
        .to({ type: "note", ids: noteIds }, "notebook")
        .unlink();
    });
  }

  async contentBlocks(id: string) {
    const content = await this.db.content.findByNoteId(id);
    if (!content || content.locked) return [];

    return (await getContentFromData(content.type, content.data)).extract(
      "blocks"
    ).blocks;
  }

  async contentBlocksWithLinks(id: string) {
    const content = await this.db.content.findByNoteId(id);
    if (!content || content.locked) return [];

    return (await getContentFromData(content.type, content.data)).extract(
      "blocksWithLink"
    ).blocks;
  }

  async internalLinks(id: string) {
    const content = await this.db.content.findByNoteId(id);
    if (!content || content.locked) return [];

    return (await getContentFromData(content.type, content.data)).extract(
      "internalLinks"
    ).internalLinks;
  }

  async deleteExpiredNotes() {
    const expiredItems = await this.db
      .sql()
      .selectFrom("notes")
      .where("type", "!=", "trash")
      .where(sql`expiryDate ->> '$.value'`, "<", Date.now())
      .select("id as noteId")
      .execute();

    if (!expiredItems.length) return;

    const toDelete = expiredItems
      .map((item) => item.noteId)
      .filter((item) => item != null);
    await this.db.trash.add("note", toDelete, "expired");
  }
}

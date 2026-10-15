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

import { ICollection } from "./collection.js";
import { getId } from "../utils/id.js";
import { getContentFromData } from "../content-types/index.js";
import { isCipher } from "../utils/crypto.js";
import {
  ContentItem,
  ContentType,
  UnencryptedContentItem,
  isDeleted,
  NoteContent
} from "../types.js";
import Database from "../api/index.js";
import { getOutputType } from "./attachments.js";
import { SQLCollection } from "../database/sql-collection.js";
import { InternalLink } from "../utils/internal-link.js";
import { tinyToTiptap } from "../migrations.js";
import { EVENTS } from "../common.js";
import { DatabaseSchema, DeleteEvent, UpdateEvent } from "../database/index.js";
import { logger } from "../logger.js";
import {
  assertDomainWriteLease,
  DomainWriteToken,
  withDomainWrite
} from "../connect/domain-lock.js";
import {
  ExpressionBuilder,
  ExpressionOrFactory,
  SqlBool,
  sql
} from "@streetwriters/kysely";

export const EMPTY_CONTENT = (noteId: string): UnencryptedContentItem => ({
  noteId,
  dateCreated: Date.now(),
  dateEdited: Date.now(),
  dateModified: Date.now(),
  id: getId(),
  localOnly: true,
  type: "tiptap",
  data: "<p></p>",
  locked: false
});

/**
 * Read-only validation callback that a guarded writer may run immediately
 * before *every* persistence boundary it owns (content row, note row, relation
 * and history side effects).
 *
 * It is deliberately asynchronous and may be invoked more than once for a
 * single write: a caller that must not persist anything after its permission,
 * session or lock state changed needs a check that runs after each `await`
 * (content post-processing, attachment/link relations, history) and not only
 * once at the start. Implementations must stay read-only and side-effect free.
 */
export type ContentPersistenceGuard = () => Promise<void>;

export class Content implements ICollection {
  name = "content";
  readonly collection: SQLCollection<"content", ContentItem>;
  constructor(private readonly db: Database) {
    this.collection = new SQLCollection(
      db.sql,
      db.transaction,
      "content",
      db.eventManager,
      db.sanitizer
    );
  }

  async init() {
    await this.collection.init();
  }

  /**
   * Persist a content row.
   *
   * Runs inside the shared domain write lock: content rows are the object the
   * vault, trash and the Connect adapter all read-modify-write, so an ordinary
   * save must not interleave with a guarded write (and vice versa). Callers
   * that already hold the lock (see `connect/domain-lock.ts`) pass the token
   * they received so the nested call runs inline instead of deadlocking.
   */
  async add(
    content: Partial<ContentItem>,
    token?: DomainWriteToken,
    guard?: ContentPersistenceGuard
  ) {
    return withDomainWrite(
      this.db,
      (writeToken) => this.addUnsafe(content, writeToken, guard),
      token
    );
  }

  private async addUnsafe(
    content: Partial<ContentItem>,
    token?: DomainWriteToken,
    guard?: ContentPersistenceGuard
  ) {
    if (typeof content.data === "object") {
      if ("data" in content.data && typeof content.data.data === "string")
        content.data = content.data.data;
      else if (!content.data.iv && !content.data.cipher)
        content.data = `<p>Content is invalid: ${JSON.stringify(
          content.data
        )}</p>`;
    }

    if (content.remote)
      throw new Error(
        "Please use db.content.merge for merging remote content."
      );

    if (content.noteId && !content.id) {
      // find content from noteId
      logger.debug("finding content id", { id: content.noteId });
      content.id = (
        await this.db
          .sql()
          .selectFrom("content")
          .where("noteId", "==", content.noteId)
          .select("id")
          .executeTakeFirst()
      )?.id;
    }

    const id = content.id || getId();

    const encryptedData = isCipher(content.data) ? content.data : undefined;
    let unencryptedData =
      typeof content.data === "string" ? content.data : undefined;

    // Post-processing is not read-only: it can save attachments and rewrite
    // note↔attachment / note↔note relations, so the guard is threaded through
    // it and re-run before those side effects (and again below before the row
    // itself is written).
    if (unencryptedData && content.type && content.noteId)
      unencryptedData = await this.postProcess(
        {
          type: content.type,
          data: unencryptedData,
          noteId: content.noteId
        },
        guard
      );

    if (content.id && (await this.exists(content.id))) {
      const contentData = encryptedData
        ? { locked: true as const, data: encryptedData }
        : unencryptedData
        ? { locked: false as const, data: unencryptedData }
        : undefined;

      if (contentData)
        logger.debug("updating content", {
          id: content.noteId,
          contentId: content.id,
          length: JSON.stringify(contentData.data).length
        });

      if (guard) await guard();
      await this.collection.update([content.id], {
        dateEdited: content.dateEdited,
        localOnly: content.localOnly,
        conflicted: content.dateResolved ? null : content.conflicted,
        dateResolved: content.dateResolved,
        noteId: content.noteId,
        ...contentData
      });

      if (content.sessionId && contentData && content.type && content.noteId) {
        if (guard) await guard();
        await this.db.noteHistory.add(content.sessionId, {
          noteId: content.noteId,
          type: content.type,
          ...contentData
        });
      }
    } else if (content.noteId) {
      const contentItem: ContentItem = {
        type: "tiptap",
        noteId: content.noteId,
        id,

        dateEdited: content.dateEdited || Date.now(),
        dateCreated: content.dateCreated || Date.now(),
        dateModified: Date.now(),
        localOnly: !!content.localOnly,

        conflicted: content.conflicted,
        dateResolved: content.dateResolved,

        ...(encryptedData
          ? { locked: true, data: encryptedData }
          : { locked: false, data: unencryptedData || "<p></p>" })
      };

      logger.debug("inserting content", {
        id: content.noteId,
        contentId: content.id,
        length: JSON.stringify(contentItem.data).length
      });

      if (guard) await guard();
      await this.collection.upsert(contentItem);

      if (content.sessionId) {
        if (guard) await guard();
        await this.db.noteHistory.add(content.sessionId, contentItem);
      }
    } else return;

    return id;
  }

  async get(id: string) {
    return this.readAndPreprocess(() => this.collection.get(id));
  }

  /**
   * Read a content row and persist the pre-processing migration (tiny→tiptap,
   * block ids) when it changed something.
   *
   * The write-back is a *compare-and-swap*: it only replaces the row while the
   * row is still the unlocked, non-deleted body (same `type` **and** same
   * `data`) this read observed. `db.transaction` is a pass-through in this
   * codebase (no real SQL transaction) and the read cannot hold the shared
   * domain lock without deadlocking the writers that call it from inside their
   * own critical section, so the conditional update is what makes the
   * read-modify-write safe.
   *
   * Only the transformed `type`/`data` columns are written: the row's other
   * metadata (`localOnly`, dates, `conflicted`, ...) belongs to whoever wrote
   * it last and must survive a migration write-back. Returning the *fresh* row
   * afterwards is what keeps a lost CAS from leaking the stale captured body:
   * when a vault lock (ciphertext + `locked`) or any other replacement lands
   * while this read is suspended, the caller sees the current locked body and
   * never the plaintext this read started from.
   */
  private async readAndPreprocess(
    read: () => Promise<ContentItem | undefined>
  ): Promise<ContentItem | undefined> {
    const content = await read();
    if (!content || isDeleted(content)) return;
    if (content.locked) return content;
    if (typeof content.data !== "string") return content;

    const observedType = content.type;
    const observedData = content.data;
    if (!(await this.preProcess(content))) return content;

    await this.collection.update(
      [content.id],
      { type: content.type, data: content.data },
      {
        modify: false,
        condition: preprocessCondition(observedType, observedData)
      }
    );

    // Re-read instead of returning the in-memory copy: the CAS may have been
    // lost (body replaced or vaulted while this read was suspended) and the
    // stored row — not the pre-write snapshot — is the only body that may be
    // handed out.
    const current = await read();
    if (!current || isDeleted(current)) return;
    return current;
  }

  // async raw(id: string) {
  //   const content = await this.collection.get(id);
  //   if (!content) return;
  //   return content;
  // }

  /**
   * Require the *live* lease of this database.
   *
   * The `*Locked` methods below bypass `withDomainWrite` on purpose (their
   * callers already hold the critical section), so they must not trust the
   * parameter being passed: a stale, copied or foreign token would otherwise
   * let a caller mutate content rows outside the lock — or while an unrelated
   * writer holds it. The check is the same identity check `withDomainWrite`
   * performs, and it runs before any read or write.
   */
  private assertDomainLease(token: DomainWriteToken): void {
    assertDomainWriteLease(this.db, token);
  }

  remove(...ids: string[]) {
    return withDomainWrite(this.db, (token) =>
      this.removeLocked(token, ...ids)
    );
  }

  /** Callers must hold the domain write lock and pass their live token. */
  removeLocked(token: DomainWriteToken, ...ids: string[]) {
    this.assertDomainLease(token);
    return this.collection.softDelete(ids);
  }

  async removeByNoteId(...ids: string[]) {
    return withDomainWrite(this.db, (token) =>
      this.removeByNoteIdLocked(token, ...ids)
    );
  }

  /** Callers must hold the domain write lock and pass their live token. */
  async removeByNoteIdLocked(token: DomainWriteToken, ...ids: string[]) {
    this.assertDomainLease(token);
    await this.db
      .sql()
      .replaceInto("content")
      .columns(["id", "dateModified", "deleted", "synced"])
      .expression((eb) =>
        eb
          .selectFrom("content")
          .where("noteId", "in", ids)
          .select((eb) => [
            "content.id",
            eb.lit(Date.now()).as("dateModified"),
            eb.lit(1).as("deleted"),
            eb.lit(0).as("synced")
          ])
      )
      .execute();

    this.db.eventManager.publish(EVENTS.databaseUpdated, <DeleteEvent>{
      collection: "content",
      type: "softDelete",
      ids
    });
  }

  async updateByNoteId(partial: Partial<ContentItem>, ...ids: string[]) {
    return withDomainWrite(this.db, (token) =>
      this.updateByNoteIdLocked(token, partial, ...ids)
    );
  }

  /** Callers must hold the domain write lock and pass their live token. */
  async updateByNoteIdLocked(
    token: DomainWriteToken,
    partial: Partial<ContentItem>,
    ...ids: string[]
  ) {
    this.assertDomainLease(token);
    await this.db
      .sql()
      .updateTable("content")
      .where("noteId", "in", ids)
      .set({
        ...partial,
        dateModified: Date.now()
      })
      .execute();

    this.db.eventManager.publish(EVENTS.databaseUpdated, <UpdateEvent>{
      collection: "content",
      type: "update",
      ids,
      item: partial
    });
  }

  async findByNoteId(noteId: string) {
    return this.readAndPreprocess(
      async () =>
        (await this.db
          .sql()
          .selectFrom("content")
          .where("noteId", "==", noteId)
          .selectAll()
          .executeTakeFirst()) as ContentItem
    );
  }

  // multi(ids: string[]) {
  //   return this.collection.getItems(ids);
  // }

  exists(id: string) {
    return this.collection.exists(id);
  }

  // async all() {
  //   return Object.values(
  //     await this.collection.getItems(this.collection.indexer.indices)
  //   );
  // }

  async downloadMedia(
    groupId: string,
    contentItem: { type: ContentType; data: string },
    notify = true
  ) {
    const content = await getContentFromData(
      contentItem.type,
      contentItem.data
    );
    if (!content) return contentItem;
    contentItem.data = await content.insertMedia(async (hashes) => {
      const attachments = await this.db.attachments.all
        .where((eb) => eb("attachments.hash", "in", hashes))
        .items();

      await this.db.fs().queueDownloads(
        attachments.map((a) => ({
          filename: a.hash,
          chunkSize: a.chunkSize
        })),
        groupId,
        notify ? { readOnDownload: false } : undefined
      );

      const sources: Record<string, string> = {};
      for (const attachment of attachments) {
        const src = await this.db.attachments.read(
          attachment.hash,
          getOutputType(attachment)
        );
        if (!src || typeof src !== "string") continue;
        sources[attachment.hash] = src;
      }
      return sources;
    });
    return contentItem;
  }

  async removeAttachments(id: string, hashes: string[]) {
    const contentItem = await this.get(id);
    if (!contentItem || isCipher(contentItem.data)) return;
    const content = await getContentFromData(
      contentItem.type,
      contentItem.data
    );
    if (!content) return;
    contentItem.data = content.removeAttachments(hashes);
    await this.add(contentItem);
  }

  async preProcess(content: NoteContent<false>) {
    let changed = false;

    // #MIGRATION: convert tiny to tiptap
    if (content.type === "tiny") {
      content.type = "tiptap";
      content.data = tinyToTiptap(content.data);
      changed = true;
    }

    // add block id on all appropriate nodes
    if (!content.data.includes("data-block-id")) {
      content.data = (
        await getContentFromData(content.type, content.data)
      ).insertBlockIds();
      changed = true;
    }

    return changed;
  }

  /**
   * Run the (write-capable) content post-processing for one body.
   *
   * `guard` — when given — is a read-only validation that runs immediately
   * before *every* persistence boundary this method (and the helpers it calls)
   * owns:
   *
   *  - the attachment row a data-URI image is saved as (the `save` callback is
   *    wrapped, so the check happens before the attachment is written, not
   *    after the whole body has been post-processed);
   *  - every note↔note relation written or removed by `processInternalLinks`;
   *  - every note↔attachment relation written or removed by
   *    `processLinkedAttachments`.
   *
   * Those are persistence boundaries like any other: a caller whose permission,
   * session or lock state can change while an `await` is suspended must not let
   * a revoked context rewrite relations or store an attachment, so each helper
   * re-checks after its last read and immediately before each mutation. Without
   * a guard (the ordinary editor/UI path) the behavior is unchanged.
   */
  async postProcess(
    contentItem: NoteContent<false> & { noteId: string },
    guard?: ContentPersistenceGuard
  ) {
    const content = await getContentFromData(
      contentItem.type,
      contentItem.data
    );
    if (!content) return contentItem.data;

    const saveAttachment = this.db.attachments.save.bind(this.db.attachments);
    const guardedSave: typeof saveAttachment = guard
      ? async (data, mime, filename) => {
          // Saving an attachment is a write: revalidate before it lands.
          await guard();
          return saveAttachment(data, mime, filename);
        }
      : saveAttachment;
    const { data, hashes, internalLinks } = await content.postProcess(
      guardedSave
    );

    if (guard) await guard();
    await this.processInternalLinks(contentItem.noteId, internalLinks, guard);
    if (guard) await guard();
    await this.processLinkedAttachments(contentItem.noteId, hashes, guard);

    return data;
  }

  private async processLinkedAttachments(
    noteId: string,
    hashes: string[],
    guard?: ContentPersistenceGuard
  ) {
    const noteAttachments = await this.db.relations
      .from({ type: "note", id: noteId }, "attachment")
      .selector.filter.select(["id", "hash"])
      .execute();

    const toDelete = noteAttachments.filter((attachment) => {
      return hashes.every((hash) => hash !== attachment.hash);
    });

    for (const attachment of toDelete) {
      if (guard) await guard();
      await this.db.relations.unlink(
        {
          id: noteId,
          type: "note"
        },
        { id: attachment.id, type: "attachment" }
      );
    }

    const toAdd = hashes.filter((hash) => {
      return hash && noteAttachments.every((a) => hash !== a.hash);
    });

    const attachments = await this.db.attachments.all
      .fields(["attachments.id"])
      .where((eb) => eb("hash", "in", toAdd))
      .items();
    for (const attachment of attachments) {
      if (guard) await guard();
      await this.db.relations.add(
        {
          id: noteId,
          type: "note"
        },
        { id: attachment.id, type: "attachment" }
      );
    }
  }

  private async processInternalLinks(
    noteId: string,
    internalLinks: InternalLink[],
    guard?: ContentPersistenceGuard
  ) {
    const links = await this.db.relations
      .from({ type: "note", id: noteId }, "note")
      .get();

    const toDelete = links.filter((link) => {
      return internalLinks.every((l) => l.id !== link.toId);
    });

    const toAdd = internalLinks.filter((link) => {
      return links.every((l) => link.id !== l.toId);
    });

    for (const link of toDelete) {
      if (guard) await guard();
      await this.db.relations.unlink(
        {
          id: noteId,
          type: "note"
        },
        { id: link.toId, type: link.toType }
      );
    }

    for (const link of toAdd) {
      const note = await this.db.notes.exists(link.id);
      if (!note) continue;
      // The existence read above is an `await`: revalidate before the relation
      // is written, never after.
      if (guard) await guard();
      await this.db.relations.add(
        {
          id: noteId,
          type: "note"
        },
        link
      );
    }
  }
}

/**
 * Compare-and-swap condition for the content read-modify-write performed by
 * `Content.readAndPreprocess`: the update may only replace the row while the
 * row is still the unlocked, non-deleted body this read observed.
 *
 * A vault lock stores ciphertext and sets `locked`/`dateEdited`, so any
 * concurrent body replacement makes at least one clause false and the write-back
 * becomes a no-op instead of restoring stale plaintext over the new content.
 * `data` holds either a plaintext document or a serialized cipher object, so it
 * is compared as a raw value rather than through the typed column. `type` is
 * part of the condition too, so a row whose type was rewritten between the read
 * and the write-back (e.g. an encrypted payload) is never relabelled.
 */
function preprocessCondition(
  observedType: string,
  observedData: string
): ExpressionOrFactory<DatabaseSchema, keyof DatabaseSchema, SqlBool> {
  return (eb: ExpressionBuilder<DatabaseSchema, keyof DatabaseSchema>) =>
    eb.and([
      eb.or([eb("locked", "is", null), eb("locked", "==", false)]),
      eb.or([eb("deleted", "is", null), eb("deleted", "==", false)]),
      sql<SqlBool>`type = ${observedType}`,
      sql<SqlBool>`data = ${observedData}`
    ]);
}

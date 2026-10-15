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

// Unit tests for the shared note lock/export gate.
//
// These exercise the *real* `isNoteLockedForExport` and `convertNoteToText`
// implementations; only the database boundary (`../common/database`) and the
// peripheral content classifier are doubled. The classifier double mirrors
// Core's structural `isCipher` contract (presence of `cipher`/`iv`/`salt`) and
// makes no cryptographic claims — the real predicate is covered by Core's own
// tests. No React Native, native module, vault unlock or share sheet is
// involved here; native Share routing is tested separately.
//
// `convertNoteToText` has two branches: unguarded calls (legacy callers) must
// reproduce the pre-change behavior of checking vault membership and delegating
// to Core, while guarded calls (primary Share path) use the strict plaintext /
// sender-fence semantics. Cases below are labeled accordingly. A supplied but
// non-callable guard fails closed in both functions: `undefined` with no
// database access, never a silent fall back to the unguarded legacy branch.

import type { Note, NoteContent } from "@notesnook/core";
import { db } from "../common/database";
import { convertNoteToText, isNoteLockedForExport } from "./note-to-text";
import type { NoteSenderGuard } from "./note-to-text";

jest.mock("@notesnook/core", () => {
  const looksEncrypted = (content: unknown) => {
    if (!content || typeof content !== "object") return false;
    const data = (content as { data?: unknown }).data;
    if (!data || typeof data !== "object") return false;
    return "cipher" in data && "iv" in data && "salt" in data;
  };
  return {
    isEncryptedContent: (content: unknown) => looksEncrypted(content),
    isDecryptedContent: (content: unknown) => !looksEncrypted(content)
  };
});

jest.mock("../common/database", () => ({
  db: {
    vaults: { itemExists: jest.fn() },
    content: { findByNoteId: jest.fn() },
    notes: { export: jest.fn() }
  }
}));

const mockDb = db as unknown as {
  vaults: { itemExists: jest.Mock };
  content: { findByNoteId: jest.Mock };
  notes: { export: jest.Mock };
};

const CIPHER = { cipher: "Y2lwaGVy", iv: "aXY=", salt: "c2FsdA==" };

function encryptedContentItem() {
  return {
    id: "content-note-1",
    type: "tiptap",
    noteId: "note-1",
    data: CIPHER,
    locked: true,
    dateEdited: 0,
    localOnly: false
  };
}

function decryptedContentItem(text = "stored plaintext") {
  return {
    id: "content-note-1",
    type: "tiptap",
    noteId: "note-1",
    data: text,
    locked: false,
    dateEdited: 0,
    localOnly: false
  };
}

/**
 * `Note` plus the optional inline `content` these fixtures supply. Core's
 * `Note` has no `content` field (it lives in its own row), but the conversion
 * gate accepts caller-supplied content, so both the decrypted and the
 * still-encrypted fixture shapes are modelled here — mirroring the production
 * `NoteWithContent` alias in `./note-to-text`.
 */
type NoteWithContent = Note & { content?: NoteContent<boolean> };

function makeNote(overrides: Record<string, unknown> = {}): NoteWithContent {
  return {
    id: "note-1",
    type: "note",
    title: "A note",
    content: { type: "tiptap", data: "decrypted body" },
    ...overrides
  } as unknown as NoteWithContent;
}

/** Guard whose Nth call returns results[N]; missing entries default to `true`. */
function makeGuard(results: Array<boolean | undefined>) {
  let i = 0;
  return jest.fn(() => (i < results.length ? results[i++] : true));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.vaults.itemExists.mockResolvedValue(false);
  mockDb.content.findByNoteId.mockResolvedValue(decryptedContentItem());
  mockDb.notes.export.mockResolvedValue("exported text");
});

describe("isNoteLockedForExport", () => {
  it("treats vault membership as locked without reading content (membership first)", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);

    await expect(isNoteLockedForExport(makeNote())).resolves.toBe(true);
    // Membership short-circuits: content is never inspected.
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
  });

  it("treats encrypted stored content as locked when not a vault member", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(false);
    mockDb.content.findByNoteId.mockResolvedValue(encryptedContentItem());

    await expect(isNoteLockedForExport(makeNote())).resolves.toBe(true);
    expect(mockDb.content.findByNoteId).toHaveBeenCalledWith("note-1");
  });

  it("treats a plain, non-member note as unlocked", async () => {
    await expect(isNoteLockedForExport(makeNote())).resolves.toBe(false);
  });

  it("propagates a rejected membership lookup", async () => {
    mockDb.vaults.itemExists.mockRejectedValue(new Error("vault down"));
    await expect(isNoteLockedForExport(makeNote())).rejects.toThrow(
      "vault down"
    );
  });

  it("propagates a rejected content lookup", async () => {
    mockDb.content.findByNoteId.mockRejectedValue(new Error("content down"));
    await expect(isNoteLockedForExport(makeNote())).rejects.toThrow(
      "content down"
    );
  });
});

describe("convertNoteToText — guarded locked exports use trusted decrypted content", () => {
  it("exports a vault-member note with the decrypted contentItem", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);

    const result = await convertNoteToText(makeNote(), true, () => true);

    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      contentItem: { type: "tiptap", data: "decrypted body" },
      disableTemplate: true,
      format: "txt"
    });
  });

  it("exports an encrypted-content note with the decrypted contentItem", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(false);
    mockDb.content.findByNoteId.mockResolvedValue(encryptedContentItem());

    const result = await convertNoteToText(makeNote(), undefined, () => true);

    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      contentItem: { type: "tiptap", data: "decrypted body" },
      disableTemplate: undefined,
      format: "txt"
    });
  });

  it("does NOT export a locked note that has no decrypted content", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);

    const result = await convertNoteToText(
      makeNote({ content: undefined }),
      true,
      () => true
    );

    expect(result).toBeUndefined();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("never passes ciphertext as contentItem for a locked note", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);

    const result = await convertNoteToText(
      makeNote({ content: { type: "tiptap", data: CIPHER } }),
      undefined,
      () => true
    );

    expect(result).toBeUndefined();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });
});

describe("convertNoteToText — unguarded exports preserve legacy semantics", () => {
  it("omits contentItem for a plain unlocked note and keeps the txt options", async () => {
    const result = await convertNoteToText(makeNote(), true);

    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      disableTemplate: true,
      format: "txt"
    });
  });

  it("never reads the content row when the note is not a vault member", async () => {
    // The legacy branch delegates content resolution to Core: whatever the
    // stored row holds is Core's business, not the converter's.
    mockDb.content.findByNoteId.mockResolvedValue(undefined);

    await convertNoteToText(makeNote());

    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      disableTemplate: undefined,
      format: "txt"
    });
  });

  it("returns '' for a valid empty note instead of a failure", async () => {
    mockDb.notes.export.mockResolvedValue("");

    await expect(convertNoteToText(makeNote())).resolves.toBe("");
  });

  it("propagates a rejected export", async () => {
    mockDb.notes.export.mockRejectedValue(new Error("export failed"));

    await expect(convertNoteToText(makeNote())).rejects.toThrow(
      "export failed"
    );
  });
});

describe("convertNoteToText — unguarded legacy contract", () => {
  it("selects the legacy branch and options when no guard is supplied", async () => {
    const result = await convertNoteToText(makeNote(), true);

    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      disableTemplate: true,
      format: "txt"
    });
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
  });

  it("passes the caller-supplied content through for a vault member", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);
    const note = makeNote();

    const result = await convertNoteToText(note, true);

    expect(result).toBe("exported text");
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    const [id, options] = mockDb.notes.export.mock.calls[0];
    expect(id).toBe("note-1");
    expect(options.format).toBe("txt");
    expect(options.disableTemplate).toBe(true);
    expect(options.contentItem).toBe(note.content);
  });

  it("omits disableTemplate when the caller did not set it", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);
    const note = makeNote();

    await convertNoteToText(note);

    const [id, options] = mockDb.notes.export.mock.calls[0];
    expect(id).toBe("note-1");
    expect(options.format).toBe("txt");
    expect(options.disableTemplate).toBeUndefined();
    expect(options.contentItem).toBe(note.content);
  });

  it("applies no structural plaintext check to the member path", async () => {
    // Pre-change behavior: vault membership alone decides that `note.content`
    // is trusted, so it is forwarded as-is even if it is not plaintext.
    mockDb.vaults.itemExists.mockResolvedValue(true);
    const note = makeNote({ content: { type: "tiptap", data: CIPHER } });

    const result = await convertNoteToText(note, true);

    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    expect(mockDb.notes.export.mock.calls[0][1].contentItem).toBe(note.content);
  });

  it("delegates Core's false for a vault member with no supplied content", async () => {
    mockDb.vaults.itemExists.mockResolvedValue(true);
    mockDb.notes.export.mockResolvedValue(false);

    const result = await convertNoteToText(
      makeNote({ content: undefined }),
      true
    );

    expect(result).toBe(false);
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    const [, options] = mockDb.notes.export.mock.calls[0];
    expect(options.format).toBe("txt");
    expect(options.disableTemplate).toBe(true);
    expect(options.contentItem).toBeUndefined();
  });

  it("does not read an encrypted stored row for a non-member", async () => {
    // The regression this branch exists for: an encrypted stored row must not
    // turn an unguarded export into an `undefined` result.
    mockDb.vaults.itemExists.mockResolvedValue(false);
    mockDb.content.findByNoteId.mockResolvedValue(encryptedContentItem());

    const result = await convertNoteToText(makeNote(), true);

    expect(result).toBe("exported text");
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).toHaveBeenCalledWith("note-1", {
      disableTemplate: true,
      format: "txt"
    });
  });

  it("returns Core's false verbatim", async () => {
    mockDb.notes.export.mockResolvedValue(false);

    await expect(convertNoteToText(makeNote(), true)).resolves.toBe(false);
  });

  it("propagates a rejected membership lookup", async () => {
    mockDb.vaults.itemExists.mockRejectedValue(new Error("vault down"));

    await expect(convertNoteToText(makeNote(), true)).rejects.toThrow(
      "vault down"
    );
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });
});

describe("convertNoteToText — optional native sender guard", () => {
  it("is inert once a guard is supplied that stays true", async () => {
    const result = await convertNoteToText(makeNote(), true, () => true);
    expect(result).toBe("exported text");
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
  });

  it("aborts before the membership lookup when the sender is already stale", async () => {
    const guard = makeGuard([false]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBeUndefined();
    expect(guard).toHaveBeenCalledWith("note-1");
    expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("aborts after the membership lookup and before reading content", async () => {
    const guard = makeGuard([true, false]);
    mockDb.vaults.itemExists.mockResolvedValue(false);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBeUndefined();
    expect(mockDb.vaults.itemExists).toHaveBeenCalledTimes(1);
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("aborts before export on the vault-member path when the sender changed", async () => {
    // Membership short-circuits content; guard call #3 is the pre-export check.
    const guard = makeGuard([true, true, false]);
    mockDb.vaults.itemExists.mockResolvedValue(true);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBeUndefined();
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("aborts before export on the unlocked path when the sender changed", async () => {
    const guard = makeGuard([true, true, true, false]);
    mockDb.vaults.itemExists.mockResolvedValue(false);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBeUndefined();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("discards the exported text when the sender changes after export", async () => {
    const guard = makeGuard([true, true, true, true, false]);
    mockDb.vaults.itemExists.mockResolvedValue(false);

    const result = await convertNoteToText(makeNote(), true, guard);

    // Export ran, but its result is dropped rather than returned as stale text.
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it("aborts after reading encrypted content and before export", async () => {
    // Non-member whose stored content is encrypted: locked via the fallback.
    mockDb.vaults.itemExists.mockResolvedValue(false);
    mockDb.content.findByNoteId.mockResolvedValue(encryptedContentItem());
    const guard = makeGuard([true, true, true, false]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(mockDb.content.findByNoteId).toHaveBeenCalledTimes(1);
    expect(mockDb.notes.export).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe("convertNoteToText — only ever touches the given note id", () => {
  it("routes every lookup through the explicit note.id", async () => {
    const note = makeNote({ id: "note-42" });
    const guard = makeGuard([true]);

    await convertNoteToText(note, false, guard);

    expect(guard).toHaveBeenCalledWith("note-42");
    expect(mockDb.vaults.itemExists).toHaveBeenCalledWith(note);
    expect(mockDb.content.findByNoteId).toHaveBeenCalledWith("note-42");
    expect(mockDb.notes.export).toHaveBeenCalledWith(
      "note-42",
      expect.anything()
    );
    // No other note id is ever consulted.
    for (const call of mockDb.content.findByNoteId.mock.calls) {
      expect(call[0]).toBe("note-42");
    }
  });
});

// A caller-supplied guard that is not callable must fail closed: `undefined`
// with zero database access, and never a silent fall back to the unguarded
// legacy branch. The falsy cases cover the previous `guard &&` skip bug where
// `null`/`false`/`0`/`""` bypassed the fence entirely.
const NON_FUNCTION_GUARDS: Array<[string, unknown]> = [
  ["null", null],
  ["false", false],
  ["0", 0],
  ["an empty string", ""],
  ["a plain object", {}]
];

describe("convertNoteToText — a supplied non-callable guard fails closed", () => {
  it.each(NON_FUNCTION_GUARDS)(
    "aborts with undefined and touches no DB for %s",
    async (_label, guardValue) => {
      const result = await convertNoteToText(
        makeNote(),
        true,
        guardValue as unknown as NoteSenderGuard
      );

      expect(result).toBeUndefined();
      // The legacy vault lookup would have run had the falsy guard been skipped.
      expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
      expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
      expect(mockDb.notes.export).not.toHaveBeenCalled();
    }
  );
});

describe("isNoteLockedForExport — a supplied non-callable guard fails closed", () => {
  it.each(NON_FUNCTION_GUARDS)(
    "aborts with undefined and touches no DB for %s",
    async (_label, guardValue) => {
      const result = await isNoteLockedForExport(
        makeNote(),
        guardValue as unknown as NoteSenderGuard
      );

      expect(result).toBeUndefined();
      expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
      expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
    }
  );
});

describe("convertNoteToText — strict guard verdicts", () => {
  it("aborts when the guard returns undefined on the first check", async () => {
    const guard = makeGuard([undefined]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBeUndefined();
    expect(guard).toHaveBeenCalledWith("note-1");
    expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("aborts when the guard turns undefined after a successful export", async () => {
    const guard = makeGuard([true, true, true, true, undefined]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it("rejects with the thrown guard error and never exports", async () => {
    const guard = jest.fn(() => {
      throw new Error("sender fence exploded");
    });

    await expect(convertNoteToText(makeNote(), true, guard)).rejects.toThrow(
      "sender fence exploded"
    );
    expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
    expect(mockDb.notes.export).not.toHaveBeenCalled();
  });

  it("returns Core's false instead of conflating it with a stale sender", async () => {
    mockDb.notes.export.mockResolvedValue(false);
    const guard = makeGuard([true]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBe(false);
    expect(result).not.toBeUndefined();
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
  });

  it("returns '' for a valid empty guarded export instead of a stale sender", async () => {
    mockDb.notes.export.mockResolvedValue("");
    const guard = makeGuard([true]);

    const result = await convertNoteToText(makeNote(), true, guard);

    expect(result).toBe("");
    expect(result).not.toBeUndefined();
    expect(mockDb.notes.export).toHaveBeenCalledTimes(1);
  });
});

describe("isNoteLockedForExport — strict guard verdicts", () => {
  it("aborts when the guard returns undefined on the first check", async () => {
    const result = await isNoteLockedForExport(makeNote(), () => undefined);

    expect(result).toBeUndefined();
    expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
  });

  it("rejects with the thrown guard error and never reads the DB", async () => {
    const guard = jest.fn(() => {
      throw new Error("fence down");
    });

    await expect(isNoteLockedForExport(makeNote(), guard)).rejects.toThrow(
      "fence down"
    );
    expect(mockDb.vaults.itemExists).not.toHaveBeenCalled();
    expect(mockDb.content.findByNoteId).not.toHaveBeenCalled();
  });
});

describe("convertNoteToText — call-type contract", () => {
  it("keeps 1–2-arg calls narrow and widens 3-arg calls for an optional guard", async () => {
    // `tsc` enforces these annotations: legacy callers keep the narrow
    // `Promise<string|false>` type, while a 3-arg call with an optional
    // `NoteSenderGuard | undefined` (the future Vault callback shape) widens to
    // `Promise<string|false|undefined>` and must typecheck.
    const legacy: Promise<string | false> = convertNoteToText(makeNote(), true);
    const guardedOptional: Promise<string | false | undefined> =
      convertNoteToText(
        makeNote(),
        true,
        undefined as NoteSenderGuard | undefined
      );

    await expect(legacy).resolves.toBeDefined();
    await expect(guardedOptional).resolves.toBeDefined();
  });
});

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
 * The operator profile's Inbox files and the hidden prompt.
 *
 * Every test uses its own temporary profile directory: no test reads, writes or
 * even looks at a real user profile, and the synthetic keys here are obvious
 * placeholders that are never used for a network call.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HiddenPromptError,
  InboxProfileError,
  InboxReceiptStore,
  KeyedLock,
  inboxApiKeySchema,
  inboxKeyFileSchema,
  inboxReceiptSchema,
  inboxReceiptsFileSchema,
  loadInboxApiKey,
  promptHiddenKey,
  saveInboxApiKey,
  withInboxReceiptFileLock,
  type HiddenPromptInput,
  type HiddenPromptOutput
} from "../src/inbox-profile.js";
import { ensureSecureDir, fileMode } from "../src/secure-files.js";
import { INBOX_LIMITS } from "../src/limits.js";

const dirs: string[] = [];
const TEST_KEY = "nn_inbox_testkey_0123456789abcdef";

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function tempProfile(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-inbox-"));
  dirs.push(base);
  const profile = path.join(base, "profile");
  await ensureSecureDir(profile);
  return profile;
}

async function writeFile(file: string, text: string, mode = 0o600): Promise<void> {
  await fs.writeFile(file, text, { mode });
  await fs.chmod(file, mode);
}

interface FakeTty {
  input: HiddenPromptInput;
  output: HiddenPromptOutput;
  write: (chunk: string) => void;
  echoed: () => string;
  rawModes: boolean[];
  listeners: number;
}

function fakeTty(isTTY = true): FakeTty {
  const handlers: ((chunk: string) => void)[] = [];
  const written: string[] = [];
  const rawModes: boolean[] = [];
  const input: HiddenPromptInput = {
    isTTY,
    setRawMode: (mode) => {
      rawModes.push(mode);
      return input;
    },
    setEncoding: () => input,
    resume: () => input,
    pause: () => input,
    on: (_event, listener) => {
      handlers.push(listener);
      return input;
    },
    removeListener: (_event, listener) => {
      const index = handlers.indexOf(listener);
      if (index >= 0) handlers.splice(index, 1);
      return input;
    }
  };
  const output: HiddenPromptOutput = {
    isTTY: isTTY,
    write: (text) => {
      written.push(text);
      return true;
    }
  };
  return {
    input,
    output,
    write: (chunk) => {
      for (const handler of handlers.slice()) handler(chunk);
    },
    echoed: () => written.join(""),
    rawModes,
    get listeners() {
      return handlers.length;
    }
  };
}

describe("inbox API key shape", () => {
  it("accepts a bounded printable key and rejects everything else", () => {
    expect(inboxApiKeySchema.safeParse(TEST_KEY).success).toBe(true);
    expect(inboxApiKeySchema.safeParse("a".repeat(INBOX_LIMITS.maxKeyChars)).success).toBe(true);

    expect(inboxApiKeySchema.safeParse("a".repeat(INBOX_LIMITS.minKeyChars - 1)).success).toBe(false);
    expect(inboxApiKeySchema.safeParse("a".repeat(INBOX_LIMITS.maxKeyChars + 1)).success).toBe(false);
    expect(inboxApiKeySchema.safeParse(`${TEST_KEY} `).success).toBe(false);
    expect(inboxApiKeySchema.safeParse(TEST_KEY.replace("_", " ")).success).toBe(false);
    expect(inboxApiKeySchema.safeParse(`${TEST_KEY}\n`).success).toBe(false);
    expect(inboxApiKeySchema.safeParse(`Bearer ${TEST_KEY}`).success).toBe(false);
    expect(inboxApiKeySchema.safeParse("nn_inbox_kéy_0123456789").success).toBe(false);
  });

  it("is a strict, versioned document", () => {
    expect(
      inboxKeyFileSchema.safeParse({ v: 1, createdAt: 1, apiKey: TEST_KEY }).success
    ).toBe(true);
    expect(
      inboxKeyFileSchema.safeParse({ v: 2, createdAt: 1, apiKey: TEST_KEY }).success
    ).toBe(false);
    expect(
      inboxKeyFileSchema.safeParse({ v: 1, apiKey: TEST_KEY }).success
    ).toBe(false);
    expect(
      inboxKeyFileSchema.safeParse({
        v: 1,
        createdAt: 1,
        apiKey: TEST_KEY,
        broker: { id: "x" }
      }).success
    ).toBe(false);
  });
});

describe("inbox key file on disk", () => {
  it("round-trips a 0600 file inside the 0700 profile", async () => {
    const profile = await tempProfile();
    const file = path.join(profile, "inbox.key.json");
    await saveInboxApiKey(file, TEST_KEY);
    expect(fileMode(await fs.lstat(file))).toBe(0o600);
    expect(await loadInboxApiKey(file)).toBe(TEST_KEY);
    // The key file is a distinct file: nothing else in the profile appears.
    expect((await fs.readdir(profile)).sort()).toEqual(["inbox.key.json"]);
  });

  it("reports a missing key as INBOX_NOT_CONFIGURED", async () => {
    const profile = await tempProfile();
    await expect(
      loadInboxApiKey(path.join(profile, "inbox.key.json"))
    ).rejects.toMatchObject({ code: "INBOX_NOT_CONFIGURED" });
  });

  it("fails closed on a corrupt, insecure or symlinked key file", async () => {
    const profile = await tempProfile();
    const file = path.join(profile, "inbox.key.json");

    await writeFile(file, "{not json");
    await expect(loadInboxApiKey(file)).rejects.toMatchObject({
      code: "CONFIG_INVALID"
    });

    await writeFile(file, JSON.stringify({ v: 1, createdAt: 1, apiKey: "short" }));
    await expect(loadInboxApiKey(file)).rejects.toMatchObject({
      code: "CONFIG_INVALID"
    });

    await writeFile(file, JSON.stringify({ v: 1, createdAt: 1, apiKey: TEST_KEY }));
    await fs.chmod(file, 0o644);
    await expect(loadInboxApiKey(file)).rejects.toMatchObject({
      code: "CONFIG_INSECURE"
    });

    const link = path.join(profile, "link.json");
    await fs.symlink(file, link);
    await expect(loadInboxApiKey(link)).rejects.toBeInstanceOf(InboxProfileError);
    await expect(loadInboxApiKey(link)).rejects.toMatchObject({
      code: "CONFIG_INSECURE"
    });
  });

  it("refuses to write into a profile directory that is not 0700", async () => {
    const profile = await tempProfile();
    await fs.chmod(profile, 0o755);
    await expect(
      saveInboxApiKey(path.join(profile, "inbox.key.json"), TEST_KEY)
    ).rejects.toMatchObject({ reason: "insecure_mode" });
    await fs.chmod(profile, 0o700);
  });
});

describe("hidden key prompt", () => {
  it("returns what was typed and echoes nothing", async () => {
    const tty = fakeTty();
    const pending = promptHiddenKey(
      { input: tty.input, output: tty.output },
      "Inbox API key: "
    );
    tty.write(TEST_KEY);
    tty.write("\r");
    await expect(pending).resolves.toBe(TEST_KEY);
    // Only the prompt was written; the key never appears, not even masked.
    expect(tty.echoed()).toBe("Inbox API key: ");
    expect(tty.echoed()).not.toContain("testkey");
    expect(tty.echoed()).not.toContain("*");
    // The terminal is restored and the listener removed.
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.listeners).toBe(0);
  });

  it("supports backspace editing and ignores other control characters", async () => {
    const tty = fakeTty();
    const pending = promptHiddenKey({ input: tty.input, output: tty.output }, "> ");
    tty.write(`nn_inbox_x${""}y`);
    tty.write("\n");
    await expect(pending).resolves.toBe("nn_inbox_y");
  });

  it("aborts on Ctrl-C without revealing anything", async () => {
    const tty = fakeTty();
    const pending = promptHiddenKey({ input: tty.input, output: tty.output }, "> ");
    tty.write("secret");
    tty.write("\u0003");
    await expect(pending).rejects.toBeInstanceOf(HiddenPromptError);
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    expect(tty.echoed()).toBe("> ");
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.listeners).toBe(0);
  });

  it("refuses a non-TTY outright (a piped key can never be entered)", async () => {
    const tty = fakeTty(false);
    await expect(
      promptHiddenKey({ input: tty.input, output: tty.output }, "> ")
    ).rejects.toMatchObject({ reason: "not_a_tty" });
    expect(tty.listeners).toBe(0);
    expect(tty.rawModes).toEqual([]);
  });

  it("bounds an unbounded paste so it cannot pass validation", async () => {
    const tty = fakeTty();
    const pending = promptHiddenKey({ input: tty.input, output: tty.output }, "> ");
    tty.write("a".repeat(INBOX_LIMITS.maxKeyChars + 500));
    tty.write("\r");
    const value = await pending;
    expect(value.length).toBeLessThanOrEqual(INBOX_LIMITS.maxKeyChars + 1);
    expect(inboxApiKeySchema.safeParse(value).success).toBe(false);
  });
});

describe("bounded write receipts", () => {
  const receipt = (operationId: string, at: number, state: "accepted" | "uncertain" = "accepted") => ({
    operationId,
    payloadHash: "a".repeat(64),
    recipientBinding: "b".repeat(64),
    state,
    at
  });

  it("stores, upserts and removes one entry per operation id", async () => {
    const profile = await tempProfile();
    const store = new InboxReceiptStore(path.join(profile, "inbox.receipts.json"));
    expect(await store.list()).toEqual([]);

    await store.put(receipt("op-1", 1));
    await store.put(receipt("op-2", 2, "uncertain"));
    expect((await store.get("op-1"))?.state).toBe("accepted");
    expect((await store.get("op-2"))?.state).toBe("uncertain");

    await store.put({ ...receipt("op-2", 3), payloadHash: "b".repeat(64) });
    expect(await store.list()).toHaveLength(2);
    expect((await store.get("op-2"))?.payloadHash).toBe("b".repeat(64));

    await store.remove("op-1");
    expect(await store.get("op-1")).toBeUndefined();
    expect(fileMode(await fs.lstat(path.join(profile, "inbox.receipts.json")))).toBe(0o600);
  });

  it("stays bounded: the oldest receipts are dropped", async () => {
    const profile = await tempProfile();
    const store = new InboxReceiptStore(path.join(profile, "inbox.receipts.json"));
    for (let index = 0; index < INBOX_LIMITS.maxReceipts + 10; index++)
      await store.put(receipt(`op-${index}`, index));
    const all = await store.list();
    expect(all).toHaveLength(INBOX_LIMITS.maxReceipts);
    expect(all[0].operationId).toBe("op-10");
    expect(all[all.length - 1].operationId).toBe(`op-${INBOX_LIMITS.maxReceipts + 9}`);
  });

  it("fails closed on a corrupt or insecure receipt file", async () => {
    const profile = await tempProfile();
    const file = path.join(profile, "inbox.receipts.json");
    const store = new InboxReceiptStore(file);

    await writeFile(file, JSON.stringify({ v: 2, receipts: [{ operationId: "op" }] }));
    await expect(store.list()).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await writeFile(file, JSON.stringify({ v: 2, receipts: [receipt("op-1", 1)] }));
    await fs.chmod(file, 0o644);
    await expect(store.list()).rejects.toMatchObject({ code: "CONFIG_INSECURE" });
  });

  it("validates the receipt document strictly", () => {
    expect(inboxReceiptSchema.safeParse(receipt("op-1", 1)).success).toBe(true);
    expect(
      inboxReceiptSchema.safeParse({ ...receipt("op-1", 1), payloadHash: "zz" }).success
    ).toBe(false);
    expect(inboxReceiptSchema.safeParse(receipt("-bad", 1)).success).toBe(false);
    expect(
      inboxReceiptSchema.safeParse({ ...receipt("op-1", 1), state: "sent" }).success
    ).toBe(false);
    expect(
      inboxReceiptsFileSchema.safeParse({
        v: 2,
        receipts: Array.from({ length: INBOX_LIMITS.maxReceipts + 1 }, (_, index) =>
          receipt(`op-${index}`, index)
        )
      }).success
    ).toBe(false);
  });
});

describe("cross-process receipt lock", () => {
  it("fails closed while another process owns the profile lock and releases it afterwards", async () => {
    const profile = await tempProfile();
    const lockFile = path.join(profile, "inbox.capture.lock");
    let enterWork!: () => void;
    let releaseWork!: () => void;
    const entered = new Promise<void>((resolve) => (enterWork = resolve));
    const gate = new Promise<void>((resolve) => (releaseWork = resolve));

    const first = withInboxReceiptFileLock(lockFile, async () => {
      enterWork();
      await gate;
      return "first";
    });
    await entered;
    expect(fileMode(await fs.stat(lockFile))).toBe(0o600);
    await expect(
      withInboxReceiptFileLock(lockFile, async () => "duplicate")
    ).rejects.toMatchObject({ code: "INBOX_BUSY" });

    releaseWork();
    await expect(first).resolves.toBe("first");
    await expect(
      withInboxReceiptFileLock(lockFile, async () => "after-release")
    ).resolves.toBe("after-release");
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("keyed lock", () => {
  it("serializes one key and never poisons the next holder", async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const first = lock.run("op-1", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("a-end");
      return "a";
    });
    const second = lock.run("op-1", async () => {
      order.push("b-start");
      return "b";
    });
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);

    await expect(
      lock.run("op-2", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(lock.run("op-2", async () => "ok")).resolves.toBe("ok");
  });

  it("runs different keys concurrently", async () => {
    const lock = new KeyedLock();
    const started: string[] = [];
    await Promise.all([
      lock.run("a", async () => {
        started.push("a");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      lock.run("b", async () => {
        started.push("b");
      })
    ]);
    expect(started.sort()).toEqual(["a", "b"]);
  });
});

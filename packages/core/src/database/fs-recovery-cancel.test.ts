import { describe, expect, test, vi } from "vitest";
import { FileStorage } from "./fs.js";
import EventManager from "../utils/event-manager.js";

describe("sync upload cancellation", () => {
  test("cancellation during token acquisition prevents a late upload from starting", async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const getAccessToken = vi.fn(() => token);
    const uploadFile = vi.fn(() => ({
      execute: vi.fn(async () => true),
      cancel: vi.fn(async () => undefined)
    }));
    const storage = new FileStorage(
      { uploadFile } as never,
      { getAccessToken } as never,
      new EventManager()
    );

    const upload = storage.queueUploads(
      [{ filename: "attachment", chunkSize: 1 }],
      "sync-uploads"
    );
    expect(getAccessToken).toHaveBeenCalledOnce();
    await storage.cancel("sync-uploads");
    releaseToken("old-token");
    await upload;

    expect(uploadFile).not.toHaveBeenCalled();
    expect(storage.groups.uploads.has("sync-uploads")).toBe(false);
  });
});

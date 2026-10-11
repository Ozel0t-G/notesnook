import { describe, expect, test, vi } from "vitest";
import { AttachmentGeneration, FileStorage } from "./fs.js";
import EventManager from "../utils/event-manager.js";
import hosts from "../utils/constants.js";
import { bindCredential } from "../utils/credential-host-binding.js";
import { EVENTS } from "../common.js";

describe("sync upload cancellation", () => {
  test("a host switch after token acquisition cannot redirect an attachment upload", async () => {
    const original = { api: hosts.API_HOST, auth: hosts.AUTH_HOST };
    try {
      hosts.API_HOST = "https://api.veyran.northcore.space";
      hosts.AUTH_HOST = "https://auth.veyran.northcore.space";
      bindCredential("file-host-race", {
        api: hosts.API_HOST,
        auth: hosts.AUTH_HOST
      });
      const uploadFile = vi.fn();
      const storage = new FileStorage(
        { uploadFile } as never,
        {
          getAccessToken: async () => {
            hosts.API_HOST = "https://api.notesnook.com";
            return "file-host-race";
          }
        } as never,
        new EventManager()
      );
      await expect(
        storage.queueUploads(
          [{ filename: "attachment", chunkSize: 1 }],
          "sync-uploads"
        )
      ).rejects.toThrow(/Server settings changed/);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      hosts.API_HOST = original.api;
      hosts.AUTH_HOST = original.auth;
    }
  });

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

  test("a completed upload publishes the crypto generation it was queued for", async () => {
    const token = "generation-publish-token";
    bindCredential(token, { api: hosts.API_HOST, auth: hosts.AUTH_HOST });
    const uploadFile = vi.fn(() => ({
      execute: vi.fn(async () => true),
      cancel: vi.fn(async () => undefined)
    }));
    const eventManager = new EventManager();
    const published: { success: boolean; generation?: AttachmentGeneration }[] =
      [];
    eventManager.subscribe(EVENTS.fileUploaded, (event: (typeof published)[0]) =>
      published.push(event)
    );

    const storage = new FileStorage(
      { uploadFile } as never,
      { getAccessToken: async () => token } as never,
      eventManager
    );

    const generation: AttachmentGeneration = {
      iv: "iv",
      salt: "salt",
      size: 3,
      chunkSize: 1
    };
    await storage.queueUploads(
      [{ filename: "attachment", chunkSize: 1, generation }],
      "group-1"
    );

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
    expect(published[0].success).toBe(true);
    expect(published[0].generation).toEqual(generation);
  });
});

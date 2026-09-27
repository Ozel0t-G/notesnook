import { describe, expect, test, vi } from "vitest";
import { FileStorage } from "./fs.js";
import EventManager from "../utils/event-manager.js";
import hosts from "../utils/constants.js";
import { bindCredential } from "../utils/credential-host-binding.js";

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
});

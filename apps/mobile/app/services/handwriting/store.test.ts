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

import { HandwritingResult, StoreDeps, storeHandwriting } from "./store";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const result: HandwritingResult = {
  id: ID,
  pngPath: "/tmp/a/handwriting.png",
  drawingPath: "/tmp/a/handwriting.pkdrawing",
  width: 100,
  height: 50
};

function fakeDeps(overrides: Partial<StoreDeps> = {}) {
  const calls: string[] = [];
  const attachments = new Map<string, { id: string; filename: string }>();
  const deps: StoreDeps = {
    hashFile: async (p) => `hash:${p}`,
    fileSize: async () => 1234,
    hasAttachment: async (h) => attachments.has(h),
    attach: async (path, hash, mime, filename) => {
      calls.push(`attach:${filename}:${mime}`);
      attachments.set(hash, { id: `id:${hash}`, filename });
      return true;
    },
    getAttachmentId: async (h) => attachments.get(h)?.id,
    link: async (a, b) => {
      calls.push(`link:${a}->${b}`);
    },
    applyToEditor: async () => {
      calls.push("applyToEditor");
    },
    removeAttachment: async (h) => {
      calls.push(`remove:${h}`);
      attachments.delete(h);
    },
    deleteFile: async (p) => {
      calls.push(`delete:${p}`);
    },
    ...overrides
  };
  return { deps, calls, attachments };
}

describe("storeHandwriting", () => {
  test("stores the UUID-paired attachments, links them, then updates the editor", async () => {
    const { deps, calls } = fakeDeps();
    const stored = await storeHandwriting(deps, result);

    expect(stored.pngHash).toBe(`hash:${result.pngPath}`);
    expect(stored.drawingHash).toBe(`hash:${result.drawingPath}`);
    expect(calls.filter((c) => c.startsWith("attach:"))).toEqual([
      `attach:handwriting-${ID}.png:image/png`,
      `attach:handwriting-${ID}.pkdrawing:application/octet-stream`
    ]);
    const order = calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("link")).toBeGreaterThan(order.lastIndexOf("attach"));
    expect(order.indexOf("applyToEditor")).toBeGreaterThan(
      order.indexOf("link")
    );
    expect(calls).toContain(
      `link:id:hash:${result.pngPath}->id:hash:${result.drawingPath}`
    );
  });

  test("temporary plaintext files are deleted after success", async () => {
    const { deps, calls } = fakeDeps();
    await storeHandwriting(deps, result);
    expect(calls).toContain(`delete:${result.pngPath}`);
    expect(calls).toContain(`delete:${result.drawingPath}`);
  });

  test("failure while storing: editor untouched, new attachments removed, temp files deleted", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({
      attach: async (path, hash, mime, filename) => {
        if (++n === 2) return false; // pkdrawing upload fails
        calls.push(`attach:${filename}`);
        return true;
      },
      hasAttachment: async () => false,
      getAttachmentId: async (h) => `id:${h}`
    });
    await expect(storeHandwriting(deps, result)).rejects.toThrow();

    expect(calls).not.toContain("applyToEditor");
    expect(calls.some((c) => c.startsWith("link:"))).toBe(false);
    // the PNG that was stored by this run is rolled back
    expect(calls).toContain(`remove:hash:${result.pngPath}`);
    expect(calls).toContain(`delete:${result.pngPath}`);
    expect(calls).toContain(`delete:${result.drawingPath}`);
  });

  test("failure while updating the editor keeps the old version (no swap happened)", async () => {
    const { deps, calls } = fakeDeps({
      applyToEditor: async () => {
        throw new Error("editor gone");
      }
    });
    await expect(storeHandwriting(deps, result)).rejects.toThrow("editor gone");
    // newly created attachments are removed; nothing else was mutated
    expect(calls).toContain(`remove:hash:${result.pngPath}`);
    expect(calls).toContain(`remove:hash:${result.drawingPath}`);
  });

  test("rollback never removes attachments that already existed", async () => {
    const { deps, calls, attachments } = fakeDeps({
      applyToEditor: async () => {
        throw new Error("fail");
      }
    });
    // identical PNG already stored (e.g. edit without visual change)
    attachments.set(`hash:${result.pngPath}`, {
      id: "old",
      filename: `handwriting-${ID}.png`
    });
    await expect(storeHandwriting(deps, result)).rejects.toThrow();
    expect(calls).not.toContain(`remove:hash:${result.pngPath}`);
    expect(calls).toContain(`remove:hash:${result.drawingPath}`);
  });

  test("rejects a malformed id from the native side", async () => {
    const { deps, calls } = fakeDeps();
    await expect(
      storeHandwriting(deps, { ...result, id: "../evil" })
    ).rejects.toThrow();
    expect(calls).toContain(`delete:${result.pngPath}`);
  });
});

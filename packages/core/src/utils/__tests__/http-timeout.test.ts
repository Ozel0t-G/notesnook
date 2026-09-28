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

import { afterEach, describe, expect, test, vi } from "vitest";
import http, { RequestError } from "../http.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("account HTTP deadlines", () => {
  test.each(["application/json", "text/plain"])(
    "the abort deadline remains active while a %s body is pending",
    async (contentType) => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      const readBody = vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted."))
            );
          })
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input, init: RequestInit) => {
          requestSignal = init.signal as AbortSignal;
          return {
            ok: true,
            headers: new Headers({ "content-type": contentType }),
            json: readBody,
            text: readBody,
            bodyUsed: true
          };
        })
      );

      const request = http.get("https://api.veyran.northcore.space/users");
      const assertion = expect(request).rejects.toThrow("is not responding");
      await vi.advanceTimersByTimeAsync(29999);
      expect(requestSignal?.aborted).toBe(false);
      expect(readBody).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  test("a settled JSON response clears its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "account" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );
    await expect(
      http.get("https://api.veyran.northcore.space/users")
    ).resolves.toEqual({
      id: "account"
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an actual server failure preserves its recoverable contract error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error_description: "Setup is unavailable." }),
            {
              status: 503,
              headers: { "content-type": "application/json" }
            }
          )
      )
    );
    const request = http.get("https://api.veyran.northcore.space/users");
    await expect(request).rejects.toBeInstanceOf(RequestError);
    await expect(request).rejects.toThrow("Setup is unavailable.");
  });
});

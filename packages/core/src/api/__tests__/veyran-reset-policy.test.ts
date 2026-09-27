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

import { describe, expect, it, vi } from "vitest";
import UserManager from "../user-manager.js";

const requests = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn()
}));

vi.mock("../../utils/http.js", () => ({
  default: {
    get: requests.get,
    post: Object.assign(requests.post, { json: requests.post }),
    patch: Object.assign(requests.patch, { json: requests.patch }),
    delete: requests.delete
  }
}));

describe("VeyraN no-key reset safety", () => {
  it.each(["", "new-password"])(
    "rejects %j before touching local data or a network endpoint",
    async (password) => {
      const untouchedDb = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`Unexpected database access: ${String(property)}`);
          }
        }
      ) as any;

      await expect(
        UserManager.prototype.resetPasswordWithoutRecoveryKey.call(
          untouchedDb,
          password
        )
      ).rejects.toThrow(/unavailable in VeyraN/);
      expect(requests.get).not.toHaveBeenCalled();
      expect(requests.post).not.toHaveBeenCalled();
      expect(requests.patch).not.toHaveBeenCalled();
      expect(requests.delete).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, true, false])(
    "rejects the legacy destructive reset endpoint for removeAttachments=%j",
    async (removeAttachments) => {
      const untouchedDb = new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(`Unexpected database access: ${String(property)}`);
          }
        }
      ) as any;

      await expect(
        UserManager.prototype.resetUser.call(untouchedDb, removeAttachments)
      ).rejects.toThrow(/Destructive account reset is unavailable in VeyraN/);
      expect(requests.get).not.toHaveBeenCalled();
      expect(requests.post).not.toHaveBeenCalled();
      expect(requests.patch).not.toHaveBeenCalled();
      expect(requests.delete).not.toHaveBeenCalled();
    }
  );
});

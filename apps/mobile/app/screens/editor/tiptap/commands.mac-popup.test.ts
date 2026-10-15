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

let mockTab = "qa-a";
jest.mock("react-native", () => ({
  Platform: { OS: "ios", isMacCatalyst: true }
}));
jest.mock("../../../common/database", () => ({ db: {} }));
jest.mock("../../../utils/time", () => ({ sleep: jest.fn() }));
jest.mock("./utils", () => ({
  getResponse: jest.fn(),
  randId: jest.fn(),
  textInput: {}
}));
jest.mock("./use-tab-store", () => ({
  useTabStore: { getState: () => ({ currentTab: mockTab }) }
}));
import Commands from "./commands";
import { Platform } from "react-native";
import type WebView from "react-native-webview";

describe("native Web popup token confirmation", () => {
  beforeEach(() => {
    mockTab = "qa-a";
    if (Platform.OS === "ios") Platform.isMacCatalyst = true;
  });
  const create = () => {
    const commands = new Commands({ current: null });
    const send = jest.spyOn(commands, "sendCommand");
    return { commands, send };
  };
  it("addresses native Insert to the current tab and refuses an absent target", async () => {
    const { commands, send } = create();
    send.mockResolvedValue(true);
    await expect(commands.openInsert()).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith("openInsert", "qa-a");
    mockTab = "";
    send.mockClear();
    await expect(commands.openInsert()).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "hands native Insert focus to WebView only on Catalyst (%s)",
    async (mac) => {
      if (Platform.OS === "ios") Platform.isMacCatalyst = mac;
      const order: string[] = [];
      const requestFocus = jest.fn(() => order.push("focus"));
      const commands = new Commands({
        current: { requestFocus } as unknown as WebView
      });
      jest.spyOn(commands, "sendCommand").mockImplementation(async () => {
        order.push("open");
        return true;
      });
      await commands.openInsert();
      expect(order).toEqual(mac ? ["focus", "open"] : ["open"]);
      mockTab = "";
      requestFocus.mockClear();
      await expect(commands.openInsert()).resolves.toBe(false);
      expect(requestFocus).not.toHaveBeenCalled();
    }
  );
  it("addresses native Formatting to the current tab and refuses an absent target", async () => {
    const { commands, send } = create();
    send.mockResolvedValue(true);
    await expect(commands.openFormatting()).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith("openFormatting", "qa-a");
    mockTab = "";
    send.mockClear();
    await expect(commands.openFormatting()).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "hands native Formatting focus to WebView only on Catalyst (%s)",
    async (mac) => {
      if (Platform.OS === "ios") Platform.isMacCatalyst = mac;
      const order: string[] = [];
      const requestFocus = jest.fn(() => order.push("focus"));
      const commands = new Commands({
        current: { requestFocus } as unknown as WebView
      });
      jest.spyOn(commands, "sendCommand").mockImplementation(async () => {
        order.push("open");
        return true;
      });
      await commands.openFormatting();
      expect(order).toEqual(mac ? ["focus", "open"] : ["open"]);
      mockTab = "";
      requestFocus.mockClear();
      await expect(commands.openFormatting()).resolves.toBe(false);
      expect(requestFocus).not.toHaveBeenCalled();
    }
  );
  it("confirms the captured token for the same tab and foreground scope", async () => {
    const { commands, send } = create();
    send.mockResolvedValueOnce(17).mockResolvedValueOnce(true);
    await expect(commands.dismissPopup(() => true)).resolves.toBe(true);
    expect(send.mock.calls).toEqual([
      ["getPopupDismissToken", "qa-a"],
      ["dismissPopup", "qa-a", 17]
    ]);
  });
  it("never commits after a tab switch while the token is pending", async () => {
    const { commands, send } = create();
    let resolve!: (value: number) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const request = commands.dismissPopup(() => true);
    mockTab = "qa-b";
    resolve(17);
    await expect(request).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("never commits after a foreground route/modal ownership change", async () => {
    const { commands, send } = create();
    let valid = true;
    send.mockImplementationOnce(async () => {
      valid = false;
      return 17;
    });
    await expect(commands.dismissPopup(() => valid)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([null, undefined, 0, -1, 1.5])(
    "rejects unavailable or invalid token %s",
    async (token) => {
      const { commands, send } = create();
      send.mockResolvedValueOnce(token);
      await expect(commands.dismissPopup(() => true)).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    }
  );
});

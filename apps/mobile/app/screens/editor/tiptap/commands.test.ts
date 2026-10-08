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

import type { RefObject } from "react";
import type WebView from "react-native-webview";

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

jest.mock("../../../common/database", () => ({ db: {} }));

jest.mock("./use-tab-store", () => ({
  useTabStore: {
    getState: () => ({
      getTab: () => undefined,
      currentTab: "tab-1",
      biometryAvailable: false,
      biometryEnrolled: false
    })
  }
}));

jest.mock("./utils", () => ({
  getResponse: jest.fn(),
  randId: (prefix = "fn_") => `${prefix}test`,
  textInput: { current: null }
}));

import Commands from "./commands";
import { getResponse } from "./utils";

const mockedGetResponse = getResponse as unknown as {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  mockResolvedValueOnce: (value: unknown) => void;
};

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createHarness(hasWebview = true) {
  let job = "";
  const ref = {
    current: hasWebview
      ? {
          injectJavaScript: (script: string) => {
            job = script;
          }
        }
      : null
  } as unknown as RefObject<WebView | null>;
  return { commands: new Commands(ref), getJob: () => job };
}

/**
 * Runs the generated WebView job and records the arguments each command
 * received. `globalThis` is shadowed by the sandbox so the job's
 * `globalThis.commands.x(...)` calls land on it instead of the real global.
 */
function evaluateJob(job: string): Record<string, unknown[]> {
  const calls: Record<string, unknown[]> = {};
  const makeCommand = (name: string) => (...args: unknown[]) => {
    calls[name] = args;
    return true;
  };
  const sandbox = {
    commands: {
      insertTemplate: makeCommand("insertTemplate"),
      setStatus: makeCommand("setStatus")
    }
  };
  const post = () => {};
  // eslint-disable-next-line no-new-func
  new Function("globalThis", "post", job)(sandbox, post);
  return calls;
}

beforeEach(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
  mockedGetResponse.mockReset();
  mockedGetResponse.mockResolvedValue({ value: true });
});

describe("Commands.sendCommand serialization", () => {
  it("injects the exact template HTML with quotes, newlines and backslashes", async () => {
    const html =
      "<p class=\"hero\" data-x='1'>" +
      "line1\nline2\\back\\slash `tick` ${notInterpolated} " +
      LINE_SEPARATOR +
      PARAGRAPH_SEPARATOR +
      "line3</p>";
    const { commands, getJob } = createHarness();

    await commands.sendCommand("insertTemplate", html, "tab-1");
    await flush();

    const job = getJob();
    // The separators must be escaped in the injected source, never raw.
    expect(job).not.toContain(LINE_SEPARATOR);
    expect(job).not.toContain(PARAGRAPH_SEPARATOR);
    // And evaluating the job must reproduce the HTML byte for byte.
    expect(evaluateJob(job).insertTemplate).toEqual([html, "tab-1"]);
  });

  it("serializes undefined as the bare undefined token", async () => {
    const { commands, getJob } = createHarness();

    await commands.sendCommand("setStatus", undefined, "saved", "tab-1");
    await flush();

    const job = getJob();
    expect(job).toContain("setStatus(undefined,");
    expect(evaluateJob(job).setStatus).toEqual([undefined, "saved", "tab-1"]);
  });
});

describe("Commands.insertTemplate result", () => {
  it("returns true only when the webview reported true", async () => {
    mockedGetResponse.mockResolvedValueOnce({ value: true });
    const { commands } = createHarness();

    await expect(commands.insertTemplate("<p>x</p>", "tab-1")).resolves.toBe(
      true
    );
  });

  it("returns false when the webview reported false or timed out", async () => {
    mockedGetResponse.mockResolvedValueOnce({ value: false });
    const rejected = createHarness();
    await expect(
      rejected.commands.insertTemplate("<p>x</p>", "tab-1")
    ).resolves.toBe(false);

    mockedGetResponse.mockResolvedValueOnce(false);
    const timedOut = createHarness();
    await expect(
      timedOut.commands.insertTemplate("<p>x</p>", "tab-1")
    ).resolves.toBe(false);
  });

  it("returns false without a webview", async () => {
    const { commands } = createHarness(false);
    await expect(commands.insertTemplate("<p>x</p>", "tab-1")).resolves.toBe(
      false
    );
  });
});

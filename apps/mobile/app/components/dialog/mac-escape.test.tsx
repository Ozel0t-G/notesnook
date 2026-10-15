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

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

// Unrelated native imports pulled in by the real Dialog/BaseDialog ->
// event-manager chain:
// - @react-native-clipboard/clipboard calls NativeModules.RNCClipboard
//   .getEnforcing() when it loads, which throws in this test environment
//   since no native module is registered.
// - react-native-config resolves to a native/ESM leaf that Jest cannot load
//   in this environment; event-manager.ts only reads Config.isTesting to
//   skip showing a toast, so a minimal leaf with that single field is enough.
// Both are mocked here only - the event bus/registry below stay real so the
// actual CoreEventManager and mac-modal-stack registry are exercised.
jest.mock("@react-native-clipboard/clipboard", () => ({
  __esModule: true,
  default: {
    setString: jest.fn(),
    getString: jest.fn(() => Promise.resolve(""))
  }
}));

jest.mock("react-native-config", () => ({
  __esModule: true,
  default: { isTesting: true }
}));

jest.mock("@notesnook/theme", () => {
  const ReactLib = require("react");
  return {
    ScopedThemeProvider: (props: { children?: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, props.children),
    useThemeColors: () => ({
      colors: {
        primary: { background: "#fff", border: "#ddd", icon: "#000" },
        secondary: { icon: "#333" }
      }
    })
  };
});

jest.mock("react-native", () => {
  const ReactLib = require("react");
  return {
    TextInput: ReactLib.forwardRef((props: any, ref: any) =>
      ReactLib.createElement("TextInput", { ...props, ref })
    ),
    View: "View",
    KeyboardAvoidingView: (props: any) =>
      ReactLib.createElement("View", null, props.children),
    Modal: (props: any) => {
      ReactLib.useEffect(() => {
        if (props.visible) props.onShow?.();
      }, [props.visible]);
      return props.visible
        ? ReactLib.createElement("View", { testID: "native-modal" }, props.children)
        : null;
    },
    SafeAreaView: (props: any) =>
      ReactLib.createElement("View", null, props.children),
    StyleSheet: { create: (styles: any) => styles },
    TouchableOpacity: (props: any) =>
      ReactLib.createElement("Pressable", props, props.children)
  };
});

jest.mock("../../hooks/use-is-floating-keyboard", () => ({
  __esModule: true,
  default: () => false
}));

jest.mock("../../services/device-detection", () => ({ DDS: { isTab: false } }));

jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: Object.assign(
    (selector: (s: any) => unknown) => selector({}),
    { getState: () => ({ setSheetKeyboardHandler: jest.fn() }) }
  )
}));

jest.mock("../../stores/use-user-store", () => {
  const ReactLib = require("react");
  let state = { appLocked: false };
  const listeners = new Set<() => void>();
  function useUserStore(selector: (s: typeof state) => unknown) {
    const [, setTick] = ReactLib.useState(0);
    ReactLib.useEffect(() => {
      const listener = () => setTick((n: number) => n + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return selector(state);
  }
  useUserStore.getState = () => state;
  useUserStore.subscribe = (fn: (s: typeof state) => void) => {
    const listener = () => fn(state);
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  useUserStore.__setLocked = (locked: boolean) => {
    state = { appLocked: locked };
    listeners.forEach((l) => l());
  };
  return { useUserStore };
});

jest.mock("../../utils/colors", () => ({ getContainerBorder: () => ({}) }));
jest.mock("../../utils/elevation", () => ({ getElevationStyle: () => ({}) }));
jest.mock("../../utils/size", () => ({ defaultBorderRadius: 10 }));
jest.mock("../../utils/styles", () => ({ DefaultAppStyles: { GAP: 12 } }));
jest.mock("../../utils/time", () => ({ sleep: () => Promise.resolve() }));

const mockIsMacCatalyst = jest.fn(() => true);
jest.mock("../../utils/constants", () => ({
  isMacCatalyst: mockIsMacCatalyst
}));

jest.mock("../ui/transitions/bouncing-view", () => {
  const ReactLib = require("react");
  return {
    BouncingView: (props: any) =>
      ReactLib.createElement("View", null, props.children)
  };
});

jest.mock("../toast", () => ({ Toast: "Toast" }));
jest.mock("../ui/button", () => ({ Button: "Button" }));
jest.mock("../ui/input", () => ({ __esModule: true, default: "Input" }));
jest.mock("../ui/input/form-input", () => ({ FormInput: "FormInput" }));
jest.mock("../ui/notice", () => ({ Notice: "Notice" }));
jest.mock("../ui/seperator", () => ({ __esModule: true, default: "Seperator" }));

jest.mock("./dialog-buttons", () => {
  const ReactLib = require("react");
  return {
    __esModule: true,
    default: (props: any) =>
      ReactLib.createElement(
        "View",
        { testID: "dialog-buttons" },
        ReactLib.createElement("Pressable", {
          testID: "dialog-positive",
          onPress: props.onPressPositive,
          disabled: !props.onPressPositive
        }),
        ReactLib.createElement("Pressable", {
          testID: "dialog-negative",
          onPress: props.onPressNegative
        }),
        props.loading
          ? ReactLib.createElement("Text", { testID: "dialog-loading" })
          : null
      )
  };
});

jest.mock("./dialog-header", () => ({ __esModule: true, default: "DialogHeader" }));

import {
  __resetMacModalStackForTests,
  consumeMacEscape,
  registerMacModal
} from "../../services/mac-modal-stack";
import { eSendEvent } from "../../services/event-manager";
import { eOpenSimpleDialog } from "../../utils/events";
import { useUserStore } from "../../stores/use-user-store";
import { Dialog } from "./index";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setAppLocked(locked: boolean) {
  act(() => (useUserStore as any).__setLocked(locked));
}

function showDialog(info: Record<string, unknown>, context = "global") {
  act(() => {
    eSendEvent(eOpenSimpleDialog, { context, ...info } as any);
  });
}

/**
 * consumeMacEscape() can synchronously trigger a Dialog's hide() (setState),
 * whose registry dismissed() call only runs from that Dialog's own passive
 * effect. Calling consumeMacEscape() outside act() leaves that effect
 * unflushed, so a second, unwrapped call right after would still see the
 * registry entry as active/closing instead of gone. Wrapping every call in
 * act() flushes the effect before the result is used in an assertion.
 */
function pressEscape(): boolean {
  let result = false;
  act(() => {
    result = consumeMacEscape();
  });
  return result;
}

describe("Dialog Mac escape ownership", () => {
  let tree: ReactTestRenderer | undefined;

  beforeEach(() => {
    __resetMacModalStackForTests();
    setAppLocked(false);
    mockIsMacCatalyst.mockReturnValue(true);
    act(() => {
      tree = create(
        React.createElement(Dialog, { context: "global" }) as React.ReactElement
      );
    });
  });

  afterEach(() => {
    if (tree) {
      act(() => tree!.unmount());
      tree = undefined;
    }
  });

  it("Escape closes a shown dialog through the real event bus without running positive/negative actions", () => {
    const onClose = jest.fn();
    const positivePress = jest.fn();
    showDialog({ title: "Delete note?", positivePress, onClose });

    expect(pressEscape()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(positivePress).not.toHaveBeenCalled();

    // Already closed: nothing left for a second Escape to consume.
    expect(pressEscape()).toBe(false);
  });

  it("pressing the negative button still hides the dialog and fires onClose normally", async () => {
    const onClose = jest.fn();
    showDialog({ title: "X", onClose });

    const negativeButton = tree!.root.findByProps({ testID: "dialog-negative" });
    // onNegativePress is async: a bare `act(() => negativeButton.props.onPress())`
    // implicitly returns that pending promise from the act callback, which React
    // warns about ("You called act(async () => ...) without await") and leaves
    // this act scope open across later synchronous act() calls in other tests.
    await act(async () => {
      await negativeButton.props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a loading positive action blocks Escape; once settled, Escape works again", async () => {
    const onClose = jest.fn();
    let resolvePositive: (value: boolean) => void = () => {};
    const positivePress = jest.fn(
      () => new Promise<boolean>((resolve) => (resolvePositive = resolve))
    );
    showDialog({ title: "Loading dialog", positivePress, onClose });

    const positiveButton = tree!.root.findByProps({ testID: "dialog-positive" });
    act(() => {
      positiveButton.props.onPress();
    });

    // Loading: Escape is consumed but must not close while an action is in flight.
    expect(pressEscape()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolvePositive(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(positivePress).toHaveBeenCalledTimes(1);
    expect(pressEscape()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("updating disableBackdropClosing on an already-shown dialog does not reorder it ahead of a sheet presented afterwards", () => {
    showDialog({ title: "A", disableBackdropClosing: true });

    // Blocked while disableBackdropClosing is set; consumed, not closed.
    expect(pressEscape()).toBe(true);

    const sheetClose = jest.fn();
    const sheet = registerMacModal("sheet", () => true, sheetClose);
    sheet.present();

    // Re-show with the flag cleared: this must not bump the dialog ahead of
    // the sheet presented after it.
    showDialog({ title: "A", disableBackdropClosing: false });

    expect(pressEscape()).toBe(true);
    expect(sheetClose).toHaveBeenCalledTimes(1);
  });

  it("mixed stack: Escape closes whichever was presented more recently, dialog or sheet", () => {
    const onClose = jest.fn();
    showDialog({ title: "A", onClose });

    const sheetClose = jest.fn();
    const sheet = registerMacModal("sheet", () => true, sheetClose);
    sheet.present(); // newer than the dialog

    expect(pressEscape()).toBe(true);
    expect(sheetClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    sheet.dismissed();

    // Now the dialog, still active, is the only entry left.
    expect(pressEscape()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("app lock makes a visible dialog ineligible without calling its hide/onClose; unlocking re-arms it", () => {
    const onClose = jest.fn();
    showDialog({ title: "Locked test", onClose });

    setAppLocked(true);
    expect(pressEscape()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    setAppLocked(false);
    expect(pressEscape()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounting the dialog unregisters it so Escape has nothing left to consume", () => {
    showDialog({ title: "X" });
    act(() => tree!.unmount());
    tree = undefined;

    expect(pressEscape()).toBe(false);
  });

  it("off Mac, no registry entry is created at all", () => {
    mockIsMacCatalyst.mockReturnValue(false);
    act(() => tree!.unmount());
    tree = undefined;
    act(() => {
      tree = create(
        React.createElement(Dialog, { context: "global" }) as React.ReactElement
      );
    });
    showDialog({ title: "X" });

    expect(pressEscape()).toBe(false);
  });

  it("two Dialog instances scoped by context: Escape closes only the later-shown one; the older stays visible and untouched until the next Escape", () => {
    const globalClose = jest.fn();
    const globalPositive = jest.fn();
    const secondaryClose = jest.fn();

    let secondaryTree: ReactTestRenderer | undefined;
    act(() => {
      secondaryTree = create(
        React.createElement(Dialog, {
          context: "qa-secondary"
        }) as React.ReactElement
      );
    });

    showDialog(
      { title: "Global dialog", positivePress: globalPositive, onClose: globalClose },
      "global"
    );
    showDialog(
      { title: "Secondary dialog", onClose: secondaryClose },
      "qa-secondary"
    );

    // The secondary dialog was shown later via its own context-matched
    // payload (not a broadcast): Escape closes only it.
    expect(pressEscape()).toBe(true);
    expect(secondaryClose).toHaveBeenCalledTimes(1);
    expect(globalClose).not.toHaveBeenCalled();
    expect(globalPositive).not.toHaveBeenCalled();

    // The global dialog, still visible and untouched, is next.
    expect(pressEscape()).toBe(true);
    expect(globalClose).toHaveBeenCalledTimes(1);
    expect(globalPositive).not.toHaveBeenCalled();

    act(() => secondaryTree!.unmount());
  });
});

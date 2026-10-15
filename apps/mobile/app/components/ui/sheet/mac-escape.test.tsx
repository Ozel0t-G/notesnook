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

jest.mock("@notesnook/theme", () => {
  const ReactLib = require("react");
  return {
    ScopedThemeProvider: (props: { children?: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, props.children),
    useThemeColors: () => ({
      colors: {
        primary: { backdrop: "#000" },
        secondary: { background: "#eee" }
      },
      isDark: false
    })
  };
});

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isMacCatalyst: true },
  View: "View"
}));

jest.mock("../../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ bottom: 0 })
}));

const mockSettingState = {
  deviceMode: "mobile",
  sheetKeyboardHandler: true,
  dimensions: { width: 400, height: 800 }
};
jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: (selector: (s: typeof mockSettingState) => unknown) =>
    selector(mockSettingState)
}));

jest.mock("../../../stores/use-user-store", () => {
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

jest.mock("../../../utils/colors", () => ({ getContainerBorder: () => ({}) }));

const mockIsMacCatalyst = jest.fn(() => true);
jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: mockIsMacCatalyst
}));

jest.mock("../../../utils/notesnook-module", () => ({
  NotesnookModule: { isGestureNavigationEnabled: () => false }
}));

jest.mock("../../toast", () => ({ Toast: "Toast" }));
jest.mock("../../../hooks/use-reduce-motion", () => ({
  useReduceMotion: () => false
}));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    contentSurface: "#fff",
    separator: "#ccc",
    sheetRadius: 10,
    tertiaryText: "#999",
    ios: true
  })
}));

/**
 * The declared leaf: the real react-native-actions-sheet surface trimmed to
 * the show/hide/setModalVisible/isOpen + onOpen/onClose contract SheetWrapper
 * actually drives. `visibleRef` is kept live on every render (not captured
 * once by the memoized api object) so isOpen() always reflects the sheet's
 * current state instead of the value `visible` held when the api was first
 * created.
 */
let lastSheetApi: {
  show: jest.Mock;
  hide: jest.Mock;
  setModalVisible: jest.Mock;
  isOpen: jest.Mock;
} | null = null;

jest.mock("react-native-actions-sheet", () => {
  const ReactLib = require("react");
  return {
    __esModule: true,
    default: ReactLib.forwardRef((props: any, ref: any) => {
      const [visible, setVisible] = ReactLib.useState(false);
      const visibleRef = ReactLib.useRef(visible);
      visibleRef.current = visible;
      const api = ReactLib.useMemo(() => {
        const self = {
          show: jest.fn(() => {
            setVisible(true);
            Promise.resolve().then(() => props.onOpen?.());
          }),
          hide: jest.fn(() => {
            setVisible(false);
            Promise.resolve().then(() => props.onClose?.());
          }),
          setModalVisible: jest.fn((value: boolean) => {
            if (value) self.show();
            else self.hide();
          }),
          isOpen: jest.fn(() => visibleRef.current)
        };
        return self;
      }, []);
      lastSheetApi = api;
      ReactLib.useImperativeHandle(ref, () => api, [api]);
      return visible
        ? ReactLib.createElement("ActionSheetSurface", null, props.children)
        : null;
    })
  };
});

import {
  __resetMacModalStackForTests,
  consumeMacEscape
} from "../../../services/mac-modal-stack";
import { useUserStore } from "../../../stores/use-user-store";
import SheetWrapper from "./index";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setAppLocked(locked: boolean) {
  act(() => (useUserStore as any).__setLocked(locked));
}

/**
 * consumeMacEscape() can synchronously invoke the registered entry's close
 * callback, which drives the sheet mock's own setState (`setVisible`)
 * directly from that callback - not from a passive effect. A bare,
 * unwrapped `consumeMacEscape()` call therefore runs that setState outside
 * any act() scope, which is what produced the "not wrapped in act" warnings.
 * Wrapping every call in act() flushes it before the result is used in an
 * assertion, without changing when any test's own explicit `await flush()`
 * happens afterwards.
 */
function pressEscape(): boolean {
  let result = false;
  act(() => {
    result = consumeMacEscape();
  });
  return result;
}

/**
 * Mirrors RecoveryKeySheet (components/sheets/recovery-key/index.jsx): a
 * class component that calls `this.setState({ visible: true }, () => {
 * this.ref.current?.setModalVisible(true); })`. That callback runs in the
 * commit phase, before any child's *passive* effect - this is the exact
 * shape of the regression where SheetWrapper's old facade assignment (a
 * plain useEffect) had not run yet when the callback fired.
 *
 * The props type is `Record<never, never>` (not `Record<string, never>`):
 * mapping over the empty `never` key-space yields a plain `{}` with no index
 * signature, so intersecting it with React's `ClassAttributes<T>` for the
 * `ref` callback below typechecks normally instead of forcing `ref`'s type
 * down to `never`.
 */
class ClassParentSheetHost extends React.Component<
  Record<never, never>,
  { visible: boolean }
> {
  sheetRef = React.createRef<any>();

  constructor(props: Record<never, never>) {
    super(props);
    this.state = { visible: false };
  }

  open = () => {
    this.setState({ visible: true }, () => {
      this.sheetRef.current?.setModalVisible(true);
    });
  };

  render() {
    if (!this.state.visible) return null;
    return React.createElement(SheetWrapper, { fwdRef: this.sheetRef });
  }
}

describe("SheetWrapper Mac escape ownership", () => {
  let tree: ReactTestRenderer | undefined;

  beforeEach(() => {
    __resetMacModalStackForTests();
    setAppLocked(false);
    lastSheetApi = null;
    mockIsMacCatalyst.mockReturnValue(true);
  });

  afterEach(() => {
    if (tree) {
      act(() => tree!.unmount());
      tree = undefined;
    }
  });

  it("a mounted-but-unshown sheet has no eligible entry", () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });

    expect(pressEscape()).toBe(false);
  });

  it("show() through the forwarded ref is Escape-eligible; repeated Escape before onClose does not double-hide", async () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });

    act(() => fwdRef.current.show());
    await flush();

    expect(pressEscape()).toBe(true);
    expect(lastSheetApi?.hide).toHaveBeenCalledTimes(1);

    // A second Escape arriving before onClose fires must not hide twice.
    expect(pressEscape()).toBe(true);
    expect(lastSheetApi?.hide).toHaveBeenCalledTimes(1);

    await flush();

    // Once actually closed, there is nothing left for Escape to consume.
    expect(pressEscape()).toBe(false);
  });

  it("setModalVisible(true) is not Escape-eligible until the real onOpen confirms presentation", async () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });

    act(() => fwdRef.current.setModalVisible(true));
    // Native may still refuse to actually open; a ghost entry must not be
    // armed just because setModalVisible(true) was called.
    expect(pressEscape()).toBe(false);

    await flush();

    // Once the real onOpen fires, the sheet is actually presented.
    expect(pressEscape()).toBe(true);
  });

  it("closeOnTouchBackdrop=false blocks Escape without closing", async () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, {
          fwdRef,
          closeOnTouchBackdrop: false
        }) as React.ReactElement
      );
    });

    act(() => fwdRef.current.show());
    await flush();

    expect(pressEscape()).toBe(true);
    expect(lastSheetApi?.hide).not.toHaveBeenCalled();
  });

  it("forwards every other ref method unchanged", () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });

    act(() => fwdRef.current.show());
    expect(fwdRef.current.isOpen()).toBe(true);
  });

  it("app lock makes a presented sheet ineligible without duplicate hide, and unlock re-arms it", async () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });
    act(() => fwdRef.current.show());
    await flush();
    expect(lastSheetApi?.show).toHaveBeenCalledTimes(1);

    setAppLocked(true);
    expect(lastSheetApi?.hide).toHaveBeenCalledTimes(1);
    await flush();

    expect(pressEscape()).toBe(false);

    setAppLocked(false);
    expect(lastSheetApi?.show).toHaveBeenCalledTimes(2);
    await flush();

    expect(pressEscape()).toBe(true);
    expect(lastSheetApi?.hide).toHaveBeenCalledTimes(2);
  });

  it("off Mac, no registry entry is created and the ref stays byte-compatible", () => {
    mockIsMacCatalyst.mockReturnValue(false);
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });

    act(() => fwdRef.current.show());
    expect(pressEscape()).toBe(false);
  });

  it("unmount cleans up the entry so a stale ref never re-arms", async () => {
    const fwdRef = React.createRef<any>();
    act(() => {
      tree = create(
        React.createElement(SheetWrapper, { fwdRef }) as React.ReactElement
      );
    });
    act(() => fwdRef.current.show());
    await flush();
    act(() => tree!.unmount());
    tree = undefined;

    expect(pressEscape()).toBe(false);
  });

  it("a class-component parent's commit-phase setState callback can call setModalVisible immediately, matching RecoveryKeySheet's pattern", async () => {
    let hostInstance: ClassParentSheetHost | null = null;
    act(() => {
      tree = create(
        React.createElement(ClassParentSheetHost, {
          ref: (instance: ClassParentSheetHost | null) => {
            hostInstance = instance;
          }
        }) as React.ReactElement
      );
    });

    act(() => {
      hostInstance!.open();
    });

    // The facade must already be assigned to the ref by the time this
    // commit-phase callback runs, so the call actually reaches the leaf.
    expect(lastSheetApi?.setModalVisible).toHaveBeenCalledWith(true);

    await flush();

    // The leaf surface is actually visible/eligible once onOpen confirms it.
    expect(pressEscape()).toBe(true);
  });
});

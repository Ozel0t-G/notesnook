/*
This file is part of the Notesnook project (https://notesnook.com/)
Copyright (C) 2023 Streetwriters (Private) Limited
SPDX-License-Identifier: GPL-3.0-or-later
*/

// Real LinkNote and its present/onClose contract. Native controls, database,
// locale and bridge are seams; no pixel/gesture/VoiceOver claim from this test.
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

let mockOS = "ios";
let mockSheet: any;
const mockPostMessage = jest.fn();
const mockDismiss = jest.fn();
jest.mock("react-native", () => ({
  View: "View",
  TextInput: "TextInput",
  ActivityIndicator: "ActivityIndicator",
  Platform: {
    get OS() {
      return mockOS;
    }
  }
}));
let mockCompleteNativeClose: (() => void) | undefined;
const mockSetModalVisible = jest.fn();
jest.mock("react-native-actions-sheet", () => {
  const R = require("react");
  return {
    __esModule: true,
    FlatList: "FlatList",
    default: R.forwardRef((props: any, ref: any) => {
      R.useImperativeHandle(ref, () => ({
        setModalVisible: mockSetModalVisible
      }));
      // Native animation completion is the declared leaf seam. Cancel only
      // requests close; cleanup must wait for this event through both REAL
      // SheetWrapper and SheetProvider, not a direct injected LinkNote callback.
      mockCompleteNativeClose = () => props.onClose?.();
      return R.createElement("NativeSheet", null, props.children);
    })
  };
});
jest.mock("@notesnook/common", () => ({
  useIsFeatureAvailable: () => undefined
}));
jest.mock("@notesnook/core", () => ({
  createInternalLink: jest.fn(),
  EventManager: jest.requireActual(
    "../../../../../../packages/core/src/utils/event-manager"
  ).EventManager
}));
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
jest.mock("@notesnook/theme", () => ({
  ScopedThemeProvider: (props: any) =>
    React.createElement(React.Fragment, null, props.children),
  useThemeColors: () => ({
    colors: { primary: { accent: "green" }, secondary: { paragraph: "gray" } }
  })
}));
jest.mock("../../../common/database", () => ({
  db: {
    notes: { all: { sorted: async () => ({ placeholders: [] }) } },
    settings: { getGroupOptions: () => ({}) }
  }
}));
jest.mock("../../../hooks/use-db-item", () => ({ useDBItem: () => [] }));
jest.mock("../../../screens/editor/tiptap/utils", () => ({
  editorController: {
    current: {
      postMessage: mockPostMessage,
      commands: { dismissCreateInternalLinkRequest: mockDismiss }
    }
  }
}));
jest.mock("../../../services/event-manager", () => {
  const actual = jest.requireActual("../../../services/event-manager");
  return {
    ...actual,
    presentSheet: (sheet: any) => {
      mockSheet = sheet;
      actual.presentSheet(sheet);
    }
  };
});
jest.mock("@react-native-clipboard/clipboard", () => ({
  setString: jest.fn()
}));
jest.mock("react-native-config", () => ({ isTesting: true }));
jest.mock("../../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ bottom: 0 })
}));
jest.mock("../../../hooks/use-reduce-motion", () => ({
  useReduceMotion: () => false
}));
jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: (selector: any) =>
    selector({
      deviceMode: "mobile",
      sheetKeyboardHandler: true,
      dimensions: { width: 512, height: 1024 }
    })
}));
jest.mock("../../../stores/use-user-store", () => ({
  useUserStore: Object.assign(
    (selector: any) => selector({ appLocked: false }),
    { getState: () => ({ appLocked: false }) }
  )
}));
jest.mock("../../../utils/colors", () => ({ getContainerBorder: () => ({}) }));
jest.mock("../../../utils/constants", () => ({ isMacCatalyst: () => false }));
jest.mock("../../../utils/notesnook-module", () => ({
  NotesnookModule: { isGestureNavigationEnabled: () => false }
}));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    contentSurface: "white",
    separator: "gray",
    sheetRadius: 10,
    tertiaryText: "gray",
    ios: true
  })
}));
jest.mock("../../toast", () => ({ Toast: "Toast" }));
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => "Icon");
jest.mock("../../ui/typography/heading", () => ({
  __esModule: true,
  default: (props: any) => React.createElement("Heading", props)
}));

jest.mock("../../../utils/size", () => ({
  AppFontSize: { xs: 12 },
  defaultBorderRadius: 8
}));
jest.mock("../../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 12, GAP_VERTICAL: 8, GAP_VERTICAL_SMALL: 4 }
}));
jest.mock("../../ui/button", () => ({
  Button: (props: any) => React.createElement("Button", props)
}));
jest.mock("../../ui/input", () => ({
  __esModule: true,
  default: (props: any) => React.createElement("Input", props)
}));
jest.mock("../../ui/pressable", () => ({
  Pressable: (props: any) => React.createElement("Pressable", props)
}));
jest.mock("../../ui/typography/paragraph", () => ({
  __esModule: true,
  default: (props: any) => React.createElement("Paragraph", props)
}));
jest.mock("@notesnook/editor-mobile/src/utils/native-events", () => ({
  NativeEvents: { resolve: "resolve" }
}));

import LinkNote from "./index";
import SheetProvider from "../../sheet-provider";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer | undefined;
beforeEach(() => {
  mockOS = "ios";
  mockSheet = undefined;
  jest.clearAllMocks();
});
afterEach(() => {
  act(() => view?.unmount());
  view = undefined;
});

test("visible iOS Cancel uses the existing sheet completion and dismisses exactly the pending link request", async () => {
  LinkNote.present({ href: "", title: "" }, "synthetic-request");
  const close = jest.fn(() => mockSheet.onClose());
  await act(async () => {
    view = create(mockSheet.component(undefined, close));
  });
  const cancel = view!.root
    .findAllByProps({ testID: "link-note-cancel" })
    .find((node) => typeof node.type === "string")!;
  expect(cancel.props.accessibilityLabel).toBe("cancel");
  expect(cancel.props.accessibilityRole).toBe("button");
  expect(cancel.props.style.minHeight).toBe(44);
  act(() => cancel.props.onPress());
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  expect(mockDismiss).toHaveBeenCalledWith("synthetic-request");
  expect(mockPostMessage).not.toHaveBeenCalled();
});

test.each(["android", "ios"])(
  "no inert Cancel is rendered without a close callback (%s)",
  async (os) => {
    mockOS = os;
    await act(async () => {
      view = create(
        <LinkNote
          attributes={{ href: "", title: "" }}
          resolverId="synthetic-request"
          onLinkCreated={jest.fn()}
        />
      );
    });
    expect(
      view!.root.findAllByProps({ testID: "link-note-cancel" })
    ).toHaveLength(0);
  }
);

test("Android presentation stays unchanged even when a sheet close callback is available", async () => {
  mockOS = "android";
  await act(async () => {
    view = create(
      <LinkNote
        attributes={{ href: "", title: "" }}
        resolverId="synthetic-request"
        onLinkCreated={jest.fn()}
        close={jest.fn()}
      />
    );
  });
  expect(
    view!.root.findAllByProps({ testID: "link-note-cancel" })
  ).toHaveLength(0);
});

test("real presentSheet event bus, SheetProvider and SheetWrapper complete Cancel only after the native close event", async () => {
  await act(async () => {
    view = create(<SheetProvider />);
  });
  await act(async () => {
    LinkNote.present({ href: "", title: "" }, "synthetic-integration-request");
  });
  expect(mockSetModalVisible).toHaveBeenCalledWith(true);
  const cancel = view!.root
    .findAllByProps({ testID: "link-note-cancel" })
    .find((node) => typeof node.type === "string")!;
  act(() => cancel.props.onPress());
  expect(mockSetModalVisible).toHaveBeenLastCalledWith(false);
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockCompleteNativeClose).toBeDefined();
  await act(async () => mockCompleteNativeClose!());
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  expect(mockDismiss).toHaveBeenCalledWith("synthetic-integration-request");
  expect(mockPostMessage).not.toHaveBeenCalled();
  expect(
    view!.root.findAllByProps({ testID: "link-note-cancel" })
  ).toHaveLength(0);
});

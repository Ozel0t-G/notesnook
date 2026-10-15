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
import renderer, { act } from "react-test-renderer";
import { ListCustomization } from "./list-customization";
import { showAlert } from "../../utils/mac-alert";

jest.mock("@notesnook/core", () => ({
  TASK_LIST_SYMBOLS: ["list.bullet", "fork.knife", "star", "cart"]
}));

jest.mock("@notesnook/intl", () => ({
  strings: {
    cancel: () => "Cancel",
    save: () => "Save",
    tasksNewList: () => "New List",
    tasksEditList: () => "Edit List",
    tasksEnterListName: () => "List name",
    tasksListIcon: () => "Icon",
    tasksListColor: () => "Color",
    tasksCouldNotSave: () => "Could not save list",
    tasksTitle: () => "Tasks"
  }
}));

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: {
        background: "#ffffff",
        accent: "#0A84FF",
        paragraph: "#18181B"
      },
      secondary: { background: "#F6F6F8", paragraph: "#64646B" }
    }
  })
}));

jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: View };
});

jest.mock("../../utils/constants", () => ({
  isMacCatalyst: () => false
}));

jest.mock("../../utils/mac-alert", () => ({
  showAlert: jest.fn()
}));

// Avoids requireNativeComponent (unavailable under the RN Jest preset); mirrors
// the real leaf's accessibilityLabel/accessible passthrough exactly (label is
// only set when explicitly provided, accessible is derived as !!accessibilityLabel,
// with no fallback to name).
jest.mock("../../components/task-symbol-view", () => {
  const ReactActual = require("react");
  const { Text } = require("react-native");
  return {
    TaskSymbolView: ({
      name,
      accessibilityLabel
    }: {
      name: string;
      accessibilityLabel?: string;
    }) =>
      ReactActual.createElement(
        Text,
        {
          accessibilityLabel,
          accessible: !!accessibilityLabel
        },
        name
      )
  };
});

type SaveInput = { name: string; symbol: string; color: string };

let currentRenderer: renderer.ReactTestRenderer | undefined;

function renderList(
  onSave: jest.Mock<Promise<void>, [SaveInput]>,
  onClose: jest.Mock<void, []>
) {
  let instance!: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(
      <ListCustomization visible onClose={onClose} onSave={onSave} />
    );
  });
  currentRenderer = instance;
  return instance;
}

describe("ListCustomization", () => {
  afterEach(() => {
    if (currentRenderer) {
      act(() => {
        currentRenderer!.unmount();
      });
      currentRenderer = undefined;
    }
    jest.clearAllMocks();
  });

  it("saves the trimmed name with the selected symbol and color", async () => {
    const onSave = jest.fn(
      (_input: SaveInput): Promise<void> => Promise.resolve()
    );
    const onClose = jest.fn();
    const root = renderList(onSave, onClose).root;

    const nameInput = root.findByProps({ accessibilityLabel: "List name" });
    act(() => {
      nameInput.props.onChangeText("  Groceries  ");
    });

    // "fork knife" (space) is the Pressable's transformed a11y label, distinct
    // from the nested mocked symbol leaf's raw "fork.knife" (dot) label.
    const symbolButton = root.findByProps({
      accessibilityLabel: "fork knife"
    });
    act(() => {
      symbolButton.props.onPress();
    });
    expect(symbolButton.props.accessibilityState).toEqual({ selected: true });

    const colorButton = root.findByProps({ accessibilityLabel: "green" });
    act(() => {
      colorButton.props.onPress();
    });
    expect(colorButton.props.accessibilityState).toEqual({ selected: true });

    const saveButton = root.findByProps({ accessibilityLabel: "Save" });
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(onSave).toHaveBeenCalledWith({
      name: "Groceries",
      symbol: "fork.knife",
      color: "green"
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without saving when Cancel is pressed", () => {
    const onSave = jest.fn(
      (_input: SaveInput): Promise<void> => Promise.resolve()
    );
    const onClose = jest.fn();
    const root = renderList(onSave, onClose).root;

    const nameInput = root.findByProps({ accessibilityLabel: "List name" });
    act(() => {
      nameInput.props.onChangeText("Errands");
    });

    const cancelButton = root.findByProps({ accessibilityLabel: "Cancel" });
    act(() => {
      cancelButton.props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables Save for a whitespace-only name and the handler guards against it", async () => {
    const onSave = jest.fn(
      (_input: SaveInput): Promise<void> => Promise.resolve()
    );
    const onClose = jest.fn();
    const root = renderList(onSave, onClose).root;

    const nameInput = root.findByProps({ accessibilityLabel: "List name" });
    act(() => {
      nameInput.props.onChangeText("   ");
    });

    const saveButton = root.findByProps({ accessibilityLabel: "Save" });
    expect(saveButton.props.disabled).toBe(true);

    // Invoke the handler directly to prove the internal guard (not just the
    // disabled prop) blocks saving on a whitespace-only name.
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the draft open and surfaces an alert when saving fails", async () => {
    const onSave = jest.fn(
      (_input: SaveInput): Promise<void> =>
        Promise.reject(new Error("network down"))
    );
    const onClose = jest.fn();
    const root = renderList(onSave, onClose).root;

    const nameInput = root.findByProps({ accessibilityLabel: "List name" });
    act(() => {
      nameInput.props.onChangeText("Errands");
    });

    const saveButton = root.findByProps({ accessibilityLabel: "Save" });
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledWith("Tasks", "Could not save list");
    expect(
      root.findByProps({ accessibilityLabel: "List name" }).props.value
    ).toBe("Errands");
  });
});

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { MacAssistantInspector } from "./mac-assistant-inspector";

let mockMounts = 0;
let mockUnmounts = 0;
jest.mock("react-native", () => ({ View: "View", Pressable: "Pressable" }));
jest.mock("@notesnook/intl", () => ({ strings: { hide: () => "Hide" } }));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: {}, isDark: false })
}));
jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    secondarySurface: "sidebar",
    secondaryText: "secondary",
    separator: "separator"
  })
}));
jest.mock("./task-symbol-view", () => ({ TaskSymbolView: "Symbol" }));
jest.mock("./ui/typography/paragraph", () => ({
  __esModule: true,
  default: "Paragraph"
}));
jest.mock("./veyran-assistant-sidebar", () => ({
  ASSISTANT_SIDEBAR_WIDTH: 340,
  VeyranAssistantSidebar: (props: unknown) => {
    require("react").useEffect(() => {
      mockMounts++;
      return () => {
        mockUnmounts++;
      };
    }, []);
    return require("react").createElement("SidebarProbe", props);
  }
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Mac Inspector geometry with retained host", () => {
  let tree: ReactTestRenderer;
  afterEach(() => act(() => tree?.unmount()));
  it("hides interaction and AT while retaining the same panel across close and dock changes", () => {
    mockMounts = mockUnmounts = 0;
    const close = jest.fn();
    const render = (visible: boolean, docked: boolean, height = 500) => (
      <MacAssistantInspector
        visible={visible}
        docked={docked}
        height={height}
        onClose={close}
      />
    );
    act(() => {
      tree = create(render(false, false));
    });
    const inspector = () =>
      tree.root.findByProps({ testID: "mac-assistant-inspector" });
    const panel = tree.root.findByType("SidebarProbe" as never);
    expect(inspector().props.style.display).toBe("none");
    expect(inspector().props.pointerEvents).toBe("none");
    expect(inspector().props.accessibilityElementsHidden).toBe(true);
    expect(inspector().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );
    act(() => tree.update(render(true, false)));
    expect(inspector().props.style.width).toBe("100%");
    expect(inspector().props.style.height).toBe(200);
    expect(inspector().props.style.borderTopWidth).toBe(0.5);
    expect(inspector().props.pointerEvents).toBe("auto");
    expect(inspector().props.accessibilityElementsHidden).toBe(false);
    tree.root
      .findByProps({ testID: "mac-assistant-inspector-close" })
      .props.onPress();
    expect(close).toHaveBeenCalledTimes(1);
    act(() => tree.update(render(true, true)));
    expect(inspector().props.style.width).toBe(340);
    expect(inspector().props.style.height).toBe("100%");
    expect(inspector().props.style.borderLeftWidth).toBe(0.5);
    expect(tree.root.findByType("SidebarProbe" as never)).toBe(panel);
    act(() => tree.update(render(false, true)));
    expect(mockMounts).toBe(1);
    expect(mockUnmounts).toBe(0);
  });
  it("bounds the bottom Inspector to forty percent of short windows and 260pt on tall ones", () => {
    act(() => {
      tree = create(
        <MacAssistantInspector
          visible
          docked={false}
          height={2000}
          onClose={() => {}}
        />
      );
    });
    const view = () =>
      tree.root.findByProps({ testID: "mac-assistant-inspector" });
    expect(view().props.style.height).toBe(260);
    act(() =>
      tree.update(
        <MacAssistantInspector
          visible
          docked={false}
          height={300}
          onClose={() => {}}
        />
      )
    );
    expect(view().props.style.height).toBe(120);
  });
});

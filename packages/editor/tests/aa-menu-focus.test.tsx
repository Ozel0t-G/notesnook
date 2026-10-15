import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import { expect, test } from "vitest";
import { MenuButton } from "../../ui/src/components/menu/menu-button.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("keeps keyboard focus visible on styled Aa rows and preserves the unstyled menu path", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const theme = {
    colors: { "background-selected": "#123456", paragraph: "#000000" },
    fontSizes: { title: 16 },
    iconSizes: { medium: 16 }
  };
  const item = {
    type: "button" as const,
    key: "synthetic-heading",
    title: "Heading",
    styles: { button: { bg: "transparent", minHeight: 44 } }
  };
  const render = (focused: boolean, styled: boolean) => {
    act(() =>
      root.render(
        <ThemeProvider theme={theme}>
          <MenuButton
            item={styled ? item : { ...item, styles: undefined }}
            isFocused={focused}
          />
        </ThemeProvider>
      )
    );
    return container.querySelector("button")!;
  };
  try {
    const styledFocused = render(true, true);
    const focusBackground = getComputedStyle(styledFocused).backgroundColor;
    // Happy DOM keeps hex in CSSOM; browsers commonly normalize to RGB.
    expect(["#123456", "rgb(18, 52, 86)"]).toContain(focusBackground);
    expect(getComputedStyle(styledFocused).minHeight).toBe("44px");
    expect(getComputedStyle(render(false, true)).backgroundColor).not.toBe(
      focusBackground
    );
    expect(getComputedStyle(render(true, false)).backgroundColor).toBe(
      focusBackground
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

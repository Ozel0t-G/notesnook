/* SPDX-License-Identifier: GPL-3.0-or-later */

type ThemePresentationInput = {
  id?: string;
  name?: string;
  description?: string;
  authors?: readonly { name: string }[];
  homepage?: string;
};

/**
 * Change only the normal product UI for the two original bundled themes.
 * Theme IDs, persisted definitions, copyright and license attribution stay
 * intact. User-imported themes (including a renamed theme with a legacy ID)
 * retain their own metadata.
 */
export function getThemePresentation(theme: ThemePresentationInput) {
  const legacy =
    theme.authors?.[0]?.name === "Streetwriters" &&
    ((theme.id === "default-light" && theme.name === "Notesnook Light") ||
      (theme.id === "default-dark" && theme.name === "Notesnook Dark"));

  if (legacy) {
    const dark = theme.id === "default-dark";
    return {
      name: dark ? "Classic Dark" : "Classic Light",
      description: dark
        ? "A classic dark appearance."
        : "A classic light appearance.",
      author: undefined,
      homepage: undefined
    };
  }

  return {
    name: theme.name,
    description: theme.description,
    author: theme.authors?.map((author) => author.name).join(", "),
    homepage: theme.homepage
  };
}

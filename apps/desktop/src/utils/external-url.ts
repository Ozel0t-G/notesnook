// Only hand known URL schemes to the operating system. Note content can
// contain links, and Electron's shell.openExternal accepts custom handlers.
export function isExternalUrlAllowed(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === "http:" ||
      protocol === "https:" ||
      protocol === "mailto:" ||
      protocol === "nn:" ||
      protocol === "veyran:"
    );
  } catch {
    return false;
  }
}

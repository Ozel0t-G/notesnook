import { create } from "zustand";

export type AppleSection = "notes" | "tasks" | "library" | "search";

type AppleNavigationState = {
  section: AppleSection;
  contentSection: "notes" | "library";
  editorVisible: boolean;
  setSection: (section: AppleSection) => void;
  setEditorVisible: (visible: boolean) => void;
};

/** Presentation state only. React Navigation and the editor pane remain authoritative. */
export const useAppleNavigationStore = create<AppleNavigationState>((set) => ({
  section: "notes",
  contentSection: "notes",
  editorVisible: false,
  setSection: (section) =>
    set((state) => ({
      section,
      contentSection:
        section === "notes" || section === "library"
          ? section
          : state.contentSection
    })),
  setEditorVisible: (editorVisible) => set({ editorVisible })
}));

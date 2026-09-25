import { create } from "zustand";

export type AppleSection = "notes" | "tasks" | "library" | "search";

type AppleNavigationState = {
  section: AppleSection;
  editorVisible: boolean;
  setSection: (section: AppleSection) => void;
  setEditorVisible: (visible: boolean) => void;
};

/** Presentation state only. React Navigation and the editor pane remain authoritative. */
export const useAppleNavigationStore = create<AppleNavigationState>((set) => ({
  section: "notes",
  editorVisible: false,
  setSection: (section) => set({ section }),
  setEditorVisible: (editorVisible) => set({ editorVisible })
}));

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

import {
  Editor,
  getFontById,
  getTableOfContents,
  TiptapOptions,
  toBlobURL,
  usePermissionHandler
} from "@notesnook/editor";
import { strings } from "@notesnook/intl";
import {
  resolveAppleSurfaces,
  useThemeColors,
  useThemeEngineStore
} from "@notesnook/theme";
import FingerprintIcon from "mdi-react/FingerprintIcon";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useEditorController } from "../hooks/useEditorController";
import { useSafeArea } from "../hooks/useSafeArea";
import { useSettings } from "../hooks/useSettings";
import { TabItem, useTabContext, useTabStore } from "../hooks/useTabStore";
import { postAsyncWithTimeout, Settings } from "../utils";
import { EditorEvents } from "../utils/editor-events";
import { pendingSaveRequests } from "../utils/pending-saves";
import Header from "./header";
import StatusBar from "./statusbar";
import Tags from "./tags";
import TiptapEditorWrapper from "./tiptap";
import Title from "./title";
import EditorDate from "./editor-date";
import {
  MAC_TEXT_COLUMN_MAX_WIDTH,
  MAC_TEXT_COLUMN_PADDING,
  MAC_TOOLBAR_CAPSULE_CLEARANCE
} from "../utils/mac";
import { setupMacFileDrop } from "../utils/mac-drop";

globalThis.toBlobURL = toBlobURL as typeof globalThis.toBlobURL;

let didCallOnLoad = false;

/**
 * Bottom clearance the iOS document chrome reserves while the keyboard
 * editing toolbar is visible, so its last lines are never covered. Matches the
 * mobile toolbar's `minHeight` in `tiptap.tsx`.
 */
const IOS_EDITING_TOOLBAR_CLEARANCE = 45;

const Tiptap = ({
  settings,
  getContentDiv
}: {
  settings: Settings;
  getContentDiv: () => HTMLElement;
}) => {
  const contentPlaceholderRef = useRef<HTMLDivElement>(null);
  const { colors } = useThemeColors();
  /**
   * The reading canvas, i.e. the surface the note itself is drawn on: the
   * *document* role of the shared Apple surface resolver, the same role the
   * native editor pane and the WebView's page paint (see App.tsx and
   * apps/mobile/app/utils/apple-visual-tokens.ts). The loading, locked and
   * "changes not saved" overlays cover the editor completely, so they must be
   * the document surface rather than a second, slightly different tone - and
   * because the resolver is shared, an imported theme's own background and the
   * built-in VeyraN neutrals both come out right here.
   */
  const theme = useThemeEngineStore((store) => store.theme);
  const documentSurface = resolveAppleSurfaces({
    theme,
    colors,
    isDark: theme.colorScheme === "dark"
  }).documentSurface;
  /**
   * Whether this WebView is embedded in an Apple client (iPhone, iPad or Mac
   * Catalyst). `__PLATFORM__` is injected by the native app before the bundle
   * runs (apps/mobile/app/screens/editor/index.tsx; Mac is an iOS build, so it
   * is `"ios"` there too), and `isMacCatalyst` is injected alongside it. Android
   * and every other host keep the theme's own primary background.
   */
  const isApplePlatform =
    globalThis.__PLATFORM__ === "ios" || globalThis.isMacCatalyst === true;
  /**
   * The background of the full-pane overlays (loading, locked, empty and the
   * "changes not saved" notice). They cover the editor completely, so on Apple
   * they have to be the *document* role above - the same surface the note and
   * the native pane behind the WebView paint - rather than the theme's primary
   * background, which on the bundled VeyraN appearances is a different tone.
   * Non-Apple hosts keep the primary background they have always used.
   */
  const overlaySurface = isApplePlatform
    ? documentSurface
    : colors.primary.background;
  const tab = useTabContext();
  const isFocused = useTabStore((state) => state.currentTab === tab?.id);
  const [tick, setTick] = useState(0);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const noteStateUpdateTimer = useRef<NodeJS.Timeout>();
  const tabRef = useRef<TabItem>(tab);
  const biometryAvailable = useTabStore((state) => state.biometryAvailable);
  const biometryEnrolled = useTabStore((state) => state.biometryEnrolled);
  const editorRoot = useRef<HTMLDivElement>(null);
  const isFocusedRef = useRef<boolean>(false);
  const [undo, setUndo] = useState(false);
  const [redo, setRedo] = useState(false);
  const valueRef = useRef({
    undo,
    redo
  });
  const insets = useSafeArea();
  tabRef.current = tab;
  valueRef.current = {
    undo,
    redo
  };

  /**
   * The calm Apple *document chrome* (D1) is iPhone/iPad only: Mac Catalyst
   * has no web header at all (the native NSToolbar carries its actions) and
   * Android/any other host keeps the previous header. `__PLATFORM__` is
   * injected by the native app before this bundle runs.
   */
  const isIOSDocChrome =
    globalThis.__PLATFORM__ === "ios" && !settings.isMacCatalyst;
  /**
   * Whether this note may be written to under the existing rights. The quiet
   * presentation is a *visual* state only: it never flips the editor's
   * `editable` or the title's `readOnly` (a read-only note keeps its existing
   * behaviour and its static link/image toolbar tools).
   *
   * A *locked* session is not writable either: until the note is unlocked the
   * only field on the pane is the password input, whose focus must never be
   * read as "the user started writing" (see `onChromeFocus`).
   */
  const isEditable = !(
    tab.session?.readonly ||
    tab.session?.locked ||
    settings.readonly
  );
  /**
   * iOS document chrome presentation. `writing === true` means the primary
   * action is "Done" and the formatting toolbar is visible; `false` is the
   * calm reading presentation ("Edit") with the toolbar mounted but hidden. A
   * brand-new note (no `noteId` yet) starts in writing; an existing note
   * starts quiet regardless of the async load order.
   */
  const [writing, setWriting] = useState<boolean>(
    () => isIOSDocChrome && !tab.session?.noteId
  );
  /**
   * The user's own entry signal: set when they focus the title/body or press
   * the labelled Edit. It is what tells the *first save of the note being
   * typed* (keep writing) apart from an *existing note loading asynchronously*
   * (go quiet), both of which look like `undefined -> noteId` on the session.
   */
  const userEntryRef = useRef<boolean>(false);
  const noteIdRef = useRef<string | undefined>(tab.session?.noteId);
  /** iOS document chrome: the word count + tags disclosure. Closed = quiet. */
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    const next = tab.session?.noteId;
    if (noteIdRef.current === next) return;
    const prev = noteIdRef.current;
    noteIdRef.current = next;
    // A fresh, empty note enters writing with its details row closed.
    if (!next) {
      userEntryRef.current = false;
      setWriting(true);
      setDetailsOpen(false);
      return;
    }
    // The note the user is actively writing in was saved for the first time:
    // stay in writing - never flash "Edit" or drop the toolbar mid-keystroke -
    // and keep the details row exactly as the user left it.
    if (!prev && userEntryRef.current) return;
    // Any other transition - an existing note's async load, or a switch from
    // note A to note B - returns to the calm reading presentation and closes
    // the details row (it belongs to the note that was showing).
    userEntryRef.current = false;
    setWriting(false);
    setDetailsOpen(false);
  }, [tab.session?.noteId]);

  /**
   * Enter writing: the labelled "Edit" and the direct focus on the title or
   * body share this. The user-entry signal is what keeps the first save from
   * dropping back to quiet.
   */
  const enterWriting = useCallback(() => {
    /**
     * Defence in depth for the labelled "Edit": a locked session (its pane is
     * the password overlay) or a globally read-only editor must never be
     * flipped into the writing presentation or focused - the header already
     * suppresses the control there, and this guard keeps the state itself
     * unreachable regardless of how the action is invoked. The callback's
     * identity changes with `isEditable` (it is compared by the header's memo),
     * so a locked -> unlocked transition around this can never go stale.
     */
    if (!isEditable) return;
    userEntryRef.current = true;
    setWriting(true);
    editors[tab.id]?.commands.focus();
  }, [tab.id, isEditable]);

  /**
   * Exit writing: the labelled "Done" blurs this tab's body and title through
   * the editor's own commands - no document, history or read-only change -
   * and returns to the calm reading presentation.
   */
  const exitWriting = useCallback(() => {
    setWriting(false);
    userEntryRef.current = false;
    editors[tab.id]?.commands.blur();
    editorTitles[tab.id]?.current?.blur();
  }, [tab.id]);

  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), []);

  /**
   * Parent-side focus wiring: the note body and the title enter writing on a
   * real DOM focus. Focus on the header, the menus and any non-editable
   * control (the locked note's password input, for instance) is ignored.
   *
   * The scroller these events bubble through also carries the overlays, so the
   * entry has to *prove* itself: the title must be the actual `#editor-title`
   * textarea and not read-only, and the body must be the note content whose
   * editable root (`ProseMirror`) is not explicitly non-editable. A password
   * field or any other control inside the pane therefore never turns the
   * chrome into writing.
   */
  const onChromeFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!isIOSDocChrome || !isEditable) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const titleEntry =
        target.id === "editor-title" &&
        target.getAttribute("readonly") === null &&
        (target as HTMLTextAreaElement).readOnly !== true;
      const bodyRoot = (target.closest(".ProseMirror") ??
        target.closest(".main-editor")) as HTMLElement | null;
      const bodyEntry =
        !!bodyRoot && bodyRoot.getAttribute("contenteditable") !== "false";
      if (!titleEntry && !bodyEntry) return;
      userEntryRef.current = true;
      setWriting(true);
    },
    [isIOSDocChrome, isEditable]
  );

  /**
   * The wrapper stays mounted and the toolbar is only CSS-hidden in the quiet
   * presentation. A read-only note keeps its toolbar (its static link/image
   * tools), so the quiet presentation is only ever requested while editable -
   * and only when this platform actually renders the web header that carries
   * the labelled "Edit". With `noHeader` there is no Edit control at all, so
   * hiding the toolbar too would leave no way back into writing.
   */
  const readingPresentation =
    isIOSDocChrome && isEditable && !writing && !settings.noHeader;
  // REF-08 puts the collection in iPad's command row. REF-03 keeps the
  // combined caption above the title where a Back control occupies that row.
  const collectionInHeader =
    isIOSDocChrome &&
    settings.deviceMode !== "mobile" &&
    !settings.fullscreen &&
    !settings.pagedPresentation;

  useEffect(() => {
    setPasswordError(null);
  }, [tab.session?.noteId]);

  logger("info", tabRef.current.id, "rendering");

  const restoreNoteSelection = useCallback(
    (scrollTop?: number, selection?: { to: number; from: number }) => {
      if (!tabRef.current.session?.noteId) return;
      const sel = selection || tabRef.current.session?.selection;
      if (sel && sel.to && sel.from) {
        const size = editors[tabRef.current.id]?.state.doc.content.size || 0;
        if (sel.to > 0 && sel.to <= size && sel.from > 0 && sel.from <= size) {
          editors[tabRef.current.id]?.chain().setTextSelection({
            to: sel.to,
            from: sel.from
          });
        }
      }
      containerRef.current?.scrollTo({
        left: 0,
        top: scrollTop || tabRef.current.session?.scrollTop || 0,
        behavior: "auto"
      });
    },
    []
  );

  usePermissionHandler({
    claims: {
      callout: !!settings.features?.callout?.isAllowed,
      outlineList: !!settings.features?.outlineList?.isAllowed,
      taskList: !!settings.features?.taskList?.isAllowed,
      importCsvToTable: !!settings.features?.importCsvToTable?.isAllowed,
      exportTableAsCsv: !!settings.features?.exportTableAsCsv?.isAllowed,
      insertAttachment: settings.loggedIn
    },
    onPermissionDenied: (claim) => {
      post(
        EditorEvents.pro,
        {
          feature: claim
        },
        tabRef.current.id,
        tab.session?.noteId
      );
    }
  });

  const tiptapOptions = useMemo<Partial<TiptapOptions>>(() => {
    return {
      onUpdate: ({ editor, transaction }) => {
        globalThis.editorControllers[tab.id]?.contentChange(
          editor as Editor,
          transaction.getMeta("ignoreEdit")
        );

        if (valueRef.current.undo !== editor.can().undo()) {
          setUndo(editor.can().undo());
        }
        if (valueRef.current.redo !== editor.can().redo()) {
          setRedo(editor.can().redo());
        }
      },
      openAttachmentPicker: (type) => {
        globalThis.editorControllers[tab.id]?.openFilePicker(type);
        return true;
      },
      handwritingEnabled: !!globalThis.handwriting,
      templatesEnabled: !!globalThis.templates,
      openTemplatePicker: () =>
        globalThis.editorControllers[tab.id]?.openTemplatePicker(),
      editHandwriting: (image) => {
        globalThis.editorControllers[tab.id]?.editHandwriting(image);
      },
      hasHandwritingSource: (image) => {
        return postAsyncWithTimeout<boolean>(
          EditorEvents.hasHandwritingSource,
          { hash: image.hash, filename: image.filename }
        );
      },
      downloadAttachment: (attachment) => {
        globalThis.editorControllers[tab.id]?.downloadAttachment(attachment);
        return true;
      },
      previewAttachment(attachment) {
        globalThis.editorControllers[tab.id]?.previewAttachment(attachment);
        return true;
      },
      getAttachmentData(attachment) {
        return globalThis.editorControllers[tab.id]?.getAttachmentData(
          attachment
        ) as Promise<string | undefined>;
      },
      getLinkData: (url: string) => {
        return postAsyncWithTimeout(EditorEvents.getLinkData, {
          url: url
        });
      },
      createInternalLink(attributes) {
        return postAsyncWithTimeout(EditorEvents.createInternalLink, {
          attributes
        });
      },
      downloadCsvTable: (csv) => {
        console.log("download csv");
        post("editor-events:download-csv", csv);
      },
      element: getContentDiv(),
      editable: !tab.session?.readonly,
      editorProps: {
        editable: () => !tabRef.current.session?.readonly,
        handlePaste: (view, event) => {
          const hasFiles = event.clipboardData?.types?.some((type) =>
            type.startsWith("Files")
          );
          if (hasFiles && event.clipboardData?.files?.length) {
            let stopped = false;
            for (let i = 0; i < event.clipboardData.files.length; i++) {
              const file = event.clipboardData.files.item(i);
              if (!file) continue;
              if (!stopped) {
                event.preventDefault();
                event.stopPropagation();
                stopped = true;
              }
              if (!file?.type.startsWith("image/")) continue;
              const reader = new FileReader();
              reader.onload = () => {
                const data = reader.result;
                if (typeof data === "string") {
                  editors[tabRef.current.id]?.commands.insertImage({
                    src: data,
                    filename: file.name,
                    mime: file.type,
                    size: file.size
                  });
                }
              };
              reader.readAsDataURL(file);
            }
            return true;
          }
        }
      },
      content: globalThis.editorControllers[tab.id]?.content?.current,
      isMobile: true,
      doubleSpacedLines: settings.doubleSpacedLines,
      openLink: (url) => {
        return globalThis.editorControllers[tab.id]?.openLink(url) || true;
      },
      copyToClipboard: (text) => {
        globalThis.editorControllers[tab.id]?.copyToClipboard(text);
      },
      onFocus: () => {
        getContentDiv().classList.remove("searching");
      },
      onSelectionUpdate: () => {
        if (tabRef.current.session?.noteId) {
          clearTimeout(noteStateUpdateTimer.current);
          noteStateUpdateTimer.current = setTimeout(() => {
            post(
              EditorEvents.saveScroll,
              {
                selection: {
                  to: editors[tabRef.current.id]?.state.selection.to,
                  from: editors[tabRef.current.id]?.state.selection.from
                }
              },
              tabRef.current.id,
              tabRef.current.session?.noteId
            );
          }, 300);
        }
      },
      onCreate() {
        setTimeout(() => {
          restoreNoteSelection();
        }, 32);
      },
      downloadOptions: {
        corsHost: settings.corsProxy
      },
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat as "12-hour" | "24-hour" | undefined,
      dayFormat: settings.dayFormat,
      enableInputRules: settings.markdownShortcuts
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    getContentDiv,
    tab.session?.readonly,
    settings.doubleSpacedLines,
    settings.corsProxy,
    settings.dateFormat,
    settings.timeFormat,
    settings.markdownShortcuts,
    tab.id,
    tick
  ]);

  const update = useCallback(
    (
      scrollTop?: number,
      selection?: { to: number; from: number },
      searchResultIndex?: number
    ) => {
      setTick((tick) => tick + 1);
      globalThis.editorControllers[tabRef.current.id]?.setTitlePlaceholder(
        strings.noteTitle()
      );
      setTimeout(() => {
        editorControllers[tabRef.current.id]?.setLoading(false);
        setTimeout(() => {
          if (searchResultIndex !== undefined) {
            globalThis.editorControllers[
              tabRef.current.id
            ]?.scrollToSearchResult(searchResultIndex);
          } else {
            restoreNoteSelection(scrollTop, selection);
          }
        }, 300);
      }, 150);
    },
    [restoreNoteSelection]
  );

  const controller = useEditorController({
    update,
    getTableOfContents: () => {
      return !containerRef.current
        ? []
        : getTableOfContents(containerRef.current);
    },
    scrollTop: () => containerRef.current?.scrollTop || 0,
    scrollTo: (top) => {
      containerRef.current?.scrollTo({ top, behavior: "auto" });
    },
    getContentDiv() {
      return getContentDiv();
    }
  });
  const controllerRef = useRef(controller);

  globalThis.editorControllers[tab.id] = controller;

  useLayoutEffect(() => {
    if (!getContentDiv().parentElement) {
      contentPlaceholderRef.current?.appendChild(getContentDiv());
    }
    const editorRootElement = editorRoot.current;
    editorRootElement?.classList.add("active");

    if (!didCallOnLoad) {
      didCallOnLoad = true;
      post("editor-events:load");
      pendingSaveRequests
        .getPendingContentIds()
        .then(async (result) => {
          if (result && result.length) {
            dbLogger("log", "Pending save requests found... restoring");
            await pendingSaveRequests.postPendingRequests();
          }
        })
        .catch(() => {
          logger("info", "Error restoring pending contents...");
        });
    }

    const updateFocusedTab = () => {
      if (isFocusedRef.current) return;
      isFocusedRef.current = true;
      const noteId = useTabStore
        .getState()
        .tabs.find((tab) => tab.id === useTabStore.getState().currentTab)
        ?.session?.noteId;
      post(
        EditorEvents.tabFocused,
        undefined,
        useTabStore.getState().currentTab,
        noteId
      );
      editorControllers[tabRef.current.id]?.updateTab();

      restoreNoteSelection();

      if (
        !globalThis.editorControllers[tabRef.current.id]?.content.current &&
        tabRef.current.session?.noteId
      ) {
        editorControllers[tabRef.current.id]?.setLoading(true);
      }
    };

    updateFocusedTab();

    const unsub = useTabStore.subscribe((state, prevState) => {
      if (state.currentTab !== tabRef.current.id) {
        isFocusedRef.current = false;
      }
      if (state.currentTab === prevState.currentTab && isFocusedRef.current)
        return;
      updateFocusedTab();
      logger("info", "updating scroll position");
    });
    logger("info", tabRef.current.id, "active");
    return () => {
      editorRootElement?.classList.remove("active");
      logger("info", tabRef.current.id, "inactive");
      unsub();
    };
  }, [getContentDiv, restoreNoteSelection]);

  /**
   * E7: Finder drops of images/files into the Mac editor. The WebView reads the
   * dropped `File`s and sends them over the RN message channel; the native side
   * (`use-editor-events.tsx`) runs them through the same attachment flow as the
   * file/image picker. iPhone, iPad and Android keep their picker-only flow.
   */
  useEffect(() => {
    if (!settings.isMacCatalyst) return;
    setupMacFileDrop(() => {
      const state = useTabStore.getState();
      return {
        tabId: state.currentTab,
        noteId: state.getCurrentNoteId()
      };
    });
  }, [settings.isMacCatalyst]);

  const onClickEmptyArea: React.MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const y = event.nativeEvent.pageY;
      const x = event.nativeEvent.pageX;
      const element = document.elementFromPoint(x, y);
      if (!element) return;
      if (element.id === "statusbar" || element.id === "header") {
        if (
          containerRef.current?.scrollTop &&
          containerRef.current?.scrollTop > 0
        ) {
          containerRef.current?.scrollTo({
            left: 0,
            top: 0,
            behavior: "smooth"
          });
          return;
        }

        const editor = editors[tab.id];

        const firstChildNodeType = editor?.state.doc.firstChild?.type.name;
        const isSimpleNode =
          firstChildNodeType !== "image" &&
          firstChildNodeType !== "embed" &&
          firstChildNodeType !== "attachment" &&
          firstChildNodeType !== "mathBlock" &&
          firstChildNodeType !== "horizontalRule" &&
          firstChildNodeType !== "table";
        if (isSimpleNode) {
          editor?.commands.focus("end");
          return;
        }
        editor
          ?.chain()
          .insertContentAt(0, "<p></p>", {
            updateSelection: true
          })
          .focus("end")
          .run();
      }
    },
    [tab.id]
  );

  const onClickBottomArea = useCallback(() => {
    try {
      const editor = editors[tab.id];
      const docSize = editor?.state.doc.content.size;
      if (!docSize) return;
      const lastChildNodeType = editor?.state.doc.lastChild?.type.name;
      const isSimpleNode =
        lastChildNodeType !== "image" &&
        lastChildNodeType !== "embed" &&
        lastChildNodeType !== "attachment" &&
        lastChildNodeType !== "mathBlock" &&
        lastChildNodeType !== "horizontalRule" &&
        lastChildNodeType !== "table";
      if (isSimpleNode) {
        editor?.commands.focus("end");
        return;
      }
      editor
        ?.chain()
        .insertContentAt(docSize, "<p></p>", {
          updateSelection: true
        })
        .focus("end")
        .run();
    } catch (e) {
      console.log(e);
    }
  }, [tab.id]);

  return (
    <>
      <div
        style={{
          display: isFocused ? "flex" : "none",
          flex: 1,
          flexDirection: "column",
          maxWidth: "100vw",
          /**
           * Mac pins the formatting toolbar to the top of this pane (see
           * `tiptap.tsx`), so the pane has to be its containing block.
           */
          ...(settings.isMacCatalyst ? { position: "relative" } : {})
        }}
        spellCheck={!tab.session?.spellCheckDisabled}
        ref={editorRoot}
        onDoubleClick={onClickEmptyArea}
      >
        {settings.isMacCatalyst ? <div className="dialogContainer" /> : null}
        <Header
          loading={controller.loading}
          hasRedo={redo}
          hasUndo={undo}
          settings={settings}
          noHeader={settings.noHeader || false}
          surface={documentSurface}
          writing={writing}
          detailsOpen={detailsOpen}
          collectionInHeader={collectionInHeader}
          onEdit={enterWriting}
          onDone={exitWriting}
          onToggleDetails={toggleDetails}
        />

        <div
          id="editor-saving-failed-overlay"
          style={{
            display: "none",
            position: "absolute",
            zIndex: 999,
            width: "100%",
            height: "100%",
            backgroundColor: overlaySurface,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            rowGap: 10
          }}
        >
          <p
            style={{
              color: colors.primary.paragraph,
              fontSize: 18,
              fontWeight: "600",
              textAlign: "center",
              padding: "0px 20px",
              marginBottom: 0,
              userSelect: "none"
            }}
          >
            {strings.changesNotSaved()}
          </p>
          <p
            style={{
              color: colors.primary.paragraph,
              marginTop: 0,
              marginBottom: 0,
              userSelect: "none",
              textAlign: "center",
              maxWidth: "90%",
              fontSize: "0.9rem"
            }}
          >
            {strings.changesNotSavedDesc()}
          </p>

          <p
            style={{
              width: "90%",
              fontSize: "0.9rem",
              color: colors.primary.paragraph
            }}
          >
            <ol>
              <li>
                <p>{strings.changesNotSavedStep1()}</p>
              </li>
              <li>
                <p>{strings.changesNotSavedStep2()}</p>
              </li>
            </ol>
          </p>

          <button
            style={{
              backgroundColor: colors.primary.accent,
              borderRadius: 5,
              boxSizing: "border-box",
              border: "none",
              color: colors.static.white,
              width: 250,
              fontSize: "1em",
              height: 45,
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
            onMouseDown={(e) => {
              if (globalThis.keyboardShown) {
                e.preventDefault();
              }
            }}
            onClick={() => {
              const element = editorRoot.current?.querySelector<HTMLElement>(
                "#editor-saving-failed-overlay"
              );
              if (element) {
                element.style.display = "none";
              }
            }}
          >
            <p
              style={{
                userSelect: "none"
              }}
            >
              {strings.dismiss()}
            </p>
          </button>
        </div>

        <div
          onScroll={controller.scroll}
          onFocus={onChromeFocus}
          ref={containerRef}
          id="editor-container-scroller"
          style={{
            overflowY: controller.loading ? "hidden" : "scroll",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            /**
             * Mac's format bar now floats over the bottom of the pane, so the
             * note keeps its usual 12 pt of breathing room at the top and gets
             * extra bottom padding instead, so the capsule never covers the
             * last lines. The iOS document chrome reserves the bottom editing
             * toolbar's height while it is visible (writing); the quiet
             * presentation and the other platforms keep the previous zero.
             */
            paddingTop: "12px",
            paddingBottom: settings.isMacCatalyst
              ? `${MAC_TOOLBAR_CAPSULE_CLEARANCE}px`
              : isIOSDocChrome && !readingPresentation
              ? IOS_EDITING_TOOLBAR_CLEARANCE
              : 0
          }}
        >
          {settings.noHeader || tab.session?.locked ? null : (
            <>
              <div
                id="editor-details"
                /**
                 * The word count + tags row is *CSS collapsed* behind the
                 * header's labelled Details toggle on iOS - never conditionally
                 * unmounted: `StatusBar` and `Tags` keep their global refs
                 * (`statusBars`/`editorTags`) alive and keep updating while
                 * collapsed. The other clients render it as before.
                 */
                aria-hidden={isIOSDocChrome ? !detailsOpen : undefined}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  display: isIOSDocChrome && !detailsOpen ? "none" : "flex",
                  alignItems: "center",
                  padding: settings.isMacCatalyst
                    ? `0px ${MAC_TEXT_COLUMN_PADDING}px`
                    : "0px 16px",
                  paddingBottom: "3px",
                  boxSizing: "border-box",
                  minHeight: "28px",
                  /**
                   * R7: on Mac the word count and "+ Add tag" line up with the
                   * centered text column instead of sitting at the window
                   * edges. iPhone and iPad keep the full-width row.
                   */
                  ...(settings.isMacCatalyst
                    ? {
                        width: "100%",
                        maxWidth: MAC_TEXT_COLUMN_MAX_WIDTH,
                        margin: "0 auto"
                      }
                    : {})
                }}
              >
                <StatusBar
                  container={containerRef}
                  loading={controller.loading}
                />
                <Tags settings={settings} loading={controller.loading} />
              </div>

              {/**
               * The last-edited date line, from the existing `setStatus` store.
               * Mac has shown it above the title; the iOS document chrome
               * shows the same calm, real date (no fabricated "now").
               */}
              {settings.isMacCatalyst || isIOSDocChrome ? (
                <EditorDate showOrigin={!collectionInHeader} />
              ) : null}

              <Title
                titlePlaceholder={controller.titlePlaceholder}
                readonly={tab.session?.readonly || settings.readonly || false}
                controller={controllerRef}
                title={controller.title}
                fontFamily={settings.fontFamily}
                dateFormat={settings.dateFormat}
                timeFormat={settings.timeFormat}
                loading={controller.loading}
              />
            </>
          )}

          {controller.loading || tab.session?.locked ? (
            <div
              style={{
                width: "100%",
                height: "100%",
                position: "absolute",
                zIndex: 999,
                backgroundColor: overlaySurface,
                paddingRight: 12,
                paddingLeft: 12,
                display: "flex",
                flexDirection: "column",
                alignItems: tab.session?.noteLocked ? "center" : "flex-start",
                justifyContent: tab.session?.noteLocked
                  ? "center"
                  : "flex-start",
                boxSizing: "border-box",
                rowGap: 10
              }}
            >
              {tab.session?.noteLocked ? (
                <>
                  <p
                    style={{
                      color: colors.primary.paragraph,
                      fontSize: 20,
                      fontWeight: "600",
                      textAlign: "center",
                      padding: "0px 20px",
                      marginBottom: 0,
                      userSelect: "none"
                    }}
                  >
                    {controller.title}
                  </p>
                  <p
                    style={{
                      color: colors.primary.paragraph,
                      marginTop: 0,
                      marginBottom: 0,
                      userSelect: "none"
                    }}
                  >
                    {strings.thisNoteLocked()}
                  </p>

                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      const password = data.get("password");
                      if (!password) {
                        setPasswordError(strings.enterPassword());
                        return;
                      }

                      setPasswordError(null);
                      const biometrics = data.get("enrollBiometrics");

                      const result = await postAsyncWithTimeout(
                        EditorEvents.unlock,
                        {
                          password,
                          biometrics: biometrics === "on"
                        }
                      );

                      if (result && !result.success) {
                        setPasswordError(
                          result.error || strings.passwordIncorrect()
                        );
                      }
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      rowGap: 10,
                      justifyContent: "center",
                      alignItems: "center"
                    }}
                  >
                    <input
                      placeholder={strings.enterPassword()}
                      ref={controller.passwordInputRef}
                      name="password"
                      type="password"
                      onChange={() => {
                        if (passwordError) setPasswordError(null);
                      }}
                      style={{
                        boxSizing: "border-box",
                        width: 300,
                        height: 45,
                        borderRadius: 5,
                        border: `1px solid ${colors.primary.border}`,
                        paddingLeft: 12,
                        paddingRight: 12,
                        fontSize: "1em",
                        backgroundColor: "transparent",
                        caretColor: colors.primary.accent,
                        color: colors.primary.paragraph
                      }}
                    />
                    {passwordError ? (
                      <p
                        style={{
                          color: colors.error.paragraph,
                          fontSize: "0.8rem",
                          margin: 0,
                          width: 300,
                          userSelect: "none"
                        }}
                      >
                        {passwordError}
                      </p>
                    ) : null}

                    <button
                      className="unlock-note"
                      style={{
                        backgroundColor: colors.primary.accent,
                        borderRadius: 5,
                        boxSizing: "border-box",
                        border: "none",
                        color: colors.static.white,
                        width: 300,
                        fontSize: "0.9em",
                        height: 45,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                      onMouseDown={(e) => {
                        if (globalThis.keyboardShown) {
                          e.preventDefault();
                        }
                      }}
                    >
                      <p
                        style={{
                          userSelect: "none"
                        }}
                      >
                        {strings.unlockNote()}
                      </p>
                    </button>

                    {biometryAvailable && !biometryEnrolled ? (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 5
                        }}
                      >
                        <input
                          type="checkbox"
                          name="enrollBiometrics"
                          style={{
                            accentColor: colors.primary.accent
                          }}
                          onMouseDown={(e) => {
                            if (globalThis.keyboardShown) {
                              e.preventDefault();
                            }
                          }}
                        />

                        <p
                          style={{
                            color: colors.primary.paragraph,
                            marginTop: 0,
                            marginBottom: 0,
                            userSelect: "none"
                          }}
                        >
                          {strings.vaultEnableBiometrics()}
                        </p>
                      </div>
                    ) : null}
                  </form>

                  {biometryEnrolled && biometryAvailable ? (
                    <button
                      style={{
                        backgroundColor: "transparent",
                        borderRadius: 5,
                        boxSizing: "border-box",
                        border: "none",
                        color: colors.primary.accent,
                        width: 300,
                        fontSize: "0.9em",
                        height: 45,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        columnGap: 5,
                        userSelect: "none"
                      }}
                      onMouseDown={(e) => {
                        if (globalThis.keyboardShown) {
                          e.preventDefault();
                        }
                      }}
                      onClick={() => {
                        post("editor-events:unlock-biometrics");
                      }}
                    >
                      <FingerprintIcon />
                      <p
                        style={{
                          userSelect: "none"
                        }}
                      >
                        {strings.unlockWithBiometrics()}
                      </p>
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <div
                    style={{
                      height: 25,
                      width: "94%",
                      backgroundColor: colors.secondary.background,
                      borderRadius: 5,
                      marginTop: 10
                    }}
                  />

                  <div
                    style={{
                      flexDirection: "row",
                      display: "flex",
                      gap: 10
                    }}
                  >
                    <div
                      style={{
                        height: 12,
                        width: 40,
                        backgroundColor: colors.secondary.background,
                        borderRadius: 5,
                        marginTop: 10
                      }}
                    />

                    <div
                      style={{
                        height: 12,
                        width: 50,
                        backgroundColor: colors.secondary.background,
                        borderRadius: 5,
                        marginTop: 10
                      }}
                    />

                    <div
                      style={{
                        height: 12,
                        width: 100,
                        backgroundColor: colors.secondary.background,
                        borderRadius: 5,
                        marginTop: 10
                      }}
                    />
                  </div>

                  <div
                    style={{
                      height: 16,
                      width: "94%",
                      backgroundColor: colors.secondary.background,
                      borderRadius: 5,
                      marginTop: 10
                    }}
                  />

                  <div
                    style={{
                      height: 16,
                      width: "94%",
                      backgroundColor: colors.secondary.background,
                      borderRadius: 5,
                      marginTop: 10
                    }}
                  />

                  <div
                    style={{
                      height: 16,
                      width: 200,
                      backgroundColor: colors.secondary.background,
                      borderRadius: 5,
                      marginTop: 10
                    }}
                  />
                </>
              )}
            </div>
          ) : null}

          <div
            style={{
              display: tab.session?.locked ? "none" : "block"
            }}
            ref={contentPlaceholderRef}
            className="theme-scope-editor"
          />

          <div
            onClick={(e) => {
              if (tab.session?.locked) return;
              onClickBottomArea();
            }}
            onMouseDown={(e) => {
              if (tab.session?.locked) return;
              if (globalThis.keyboardShown) {
                e.preventDefault();
              }
            }}
            style={{
              width: "100%",
              display: "flex",
              flex: 1,
              minHeight: 100
            }}
          />
        </div>

        <TiptapEditorWrapper
          key={[
            tick,
            tab.id,
            settings.doubleSpacedLines ? "ds" : "ss",
            settings.dateFormat,
            settings.timeFormat,
            settings.dayFormat,
            tab.session?.readonly ? "readonly" : "edit"
          ].join("-")}
          options={tiptapOptions}
          settings={settings}
          /**
           * The quiet iOS presentation mounts the toolbar but hides it in CSS
           * (`readingPresentation`); the toolbar space is reserved above, in
           * the scroller's bottom padding, so the last lines stay visible.
           */
          readingPresentation={readingPresentation}
          onEditorUpdate={(editor) => {
            if (!editor) {
              setUndo(false);
              setRedo(false);
            }
            if (undo !== editor.can().undo()) {
              setUndo(editor.can().undo());
            }
            if (redo !== editor.can().redo()) {
              setRedo(editor.can().redo());
            }
          }}
        />
      </div>
    </>
  );
};

const TiptapProvider = (): JSX.Element => {
  const settings = useSettings();
  const { colors } = useThemeColors("editor");
  const contentRef = useRef<HTMLElement>();

  const getContentDiv = useCallback(() => {
    if (contentRef.current) {
      return contentRef.current;
    }
    const editorContainer = document.createElement("div");
    editorContainer.classList.add("selectable", "main-editor", "searching");
    editorContainer.style.flex = "1";
    editorContainer.style.cursor = "text";
    editorContainer.style.padding = settings.isMacCatalyst
      ? `0px ${MAC_TEXT_COLUMN_PADDING}px`
      : "0px 16px";
    if (settings.isMacCatalyst) {
      /**
       * E1/R7: Mac centers the note in a fixed-width text column the way macOS
       * Notes does (see `utils/mac.ts`). `overflow-x: auto` keeps wide tables
       * and code blocks inside the column instead of pushing the pane around.
       */
      editorContainer.style.boxSizing = "border-box";
      editorContainer.style.maxWidth = MAC_TEXT_COLUMN_MAX_WIDTH;
      editorContainer.style.margin = "0 auto";
      editorContainer.style.overflowX = "auto";
    }
    editorContainer.style.color = colors.primary.paragraph;
    editorContainer.style.fontSize = `${settings.fontSize}px`;
    editorContainer.style.lineHeight = `${settings.defaultLineHeight}`;
    editorContainer.style.fontFamily =
      getFontById(settings.fontFamily)?.font || "sans-serif";
    contentRef.current = editorContainer;

    return editorContainer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.style.color = colors.primary.paragraph;
    }
  }, [colors]);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.style.fontSize = `${settings.fontSize}px`;
      contentRef.current.style.fontFamily =
        getFontById(settings.fontFamily)?.font || "sans-serif";
      contentRef.current.style.lineHeight = `${settings.defaultLineHeight}`;
    }
  }, [settings.fontSize, settings.fontFamily, settings.defaultLineHeight]);

  return <Tiptap settings={settings} getContentDiv={getContentDiv} />;
};

export default TiptapProvider;

# VeyraN für Mac — Design-Audit (Mac Catalyst, "Optimize for Mac")

Read-only-Bewertung, wie weit die Mac-Catalyst-App in `apps/mobile` von einer
vollwertigen, Apple-nativen macOS-App (Vorbild: Notizen, Erinnerungen, Mail auf
macOS 26/27, Liquid-Glass-Ära) entfernt ist. Es wurde **keine Quelldatei
geändert**; dieses Dokument ist die einzige neue Datei.

Legende Aufwand: **S** klein (≤ 1 Tag), **M** mittel (mehrere Tage), **L** groß
(Architektur). Prio: **P1** wirkt un-Mac/kaputt, **P2** spürbare Politur,
**P3** nice to have. Mit *"unverifiziert"* markierte Punkte konnten nur per
Code-Lesen, nicht zur Laufzeit geprüft werden.

---

## Zusammenfassung

**Reifegrad: 4/10.**

Es gibt eine echte Grundlage, die weiter ist als bei den meisten
Catalyst-Ports: native `NSToolbar` mit Unified-Titelzeile, Segment-Control und
`UISearchTextField` (`ios/Notesnook/MacMenu/VeyraNMacToolbar.m`), ein
programmatisch gebautes Menüband mit App/File/Edit/Note/View/Settings
(`ios/Notesnook/AppDelegate.mm:241-386`), die drei Spalten Quelle/Liste/Editor
(`app/utils/mac-layout.ts`, `app/navigation/fluid-panels-view.tsx`), Hover-
Feedback (`app/components/mac-hover.tsx`), native Rechtsklick-Kontextmenüs
(`VeyraNMenu.swift:161-226`) und Sandbox-Entitlements
(`Notesnook-macOS.entitlements`).

Warum trotzdem nur 4/10: Die **Interaktions- und Typo-Schicht ist weiter iOS**.
Auf dem Mac laufen weiterhin 44-pt-Touch-Ziele, 34-pt-Large-Titles,
iOS-`Switch`-Controls, von unten einfahrende `react-native-actions-sheet`-
Sheets (37 Aufrufstellen), Swipe-Actions in Listen (`SwipeRow`), `ActionSheetIOS`,
ein `Modal`-Einstellungsblatt statt Einstellungen-Fenster. Dazu kommen kein
Mehrfachfenster (`UIApplicationSupportsMultipleScenes=false`), keine
Fenster-Wiederherstellung, kein System-Akzent/Vibrancy, kein Suchen/Drucken im
Editor, kein `Cmd-,`-Fenster und fehlende Hardened-Runtime. Das Ergebnis fühlt
sich wie ein iPad-App-Fenster auf dem Mac an, nicht wie eine Mac-App.

---

## 1. Fenster & Chrome

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| W1 | Nur Mindestgröße, kein Standardmaß, keine Wiederherstellung: `SceneDelegate.m:41` setzt ausschließlich `minimumSize = 900x600`; nirgends `restorationIdentifier`/`stateRestoration` (Grep im iOS-Projekt: 0 Treffer). | Fenster öffnet mit sinnvoller Größe, merkt Größe/Position je Sitzung. | Im `scene:willConnect…` eine `UIWindowSceneGeometryPreferencesMac` mit Default-Größe setzen; State-Restoration über `UISceneDelegate` + `NSUserActivity` ergänzen. | M | P2 |
| W2 | Einfenster-App: `Info.plist:108-124` `UIApplicationSupportsMultipleScenes=false`; Kommentar `VeyraNMacToolbar.m:125-127` ("Catalyst runs a single window here"). Es gibt kein File > Neues Fenster und "Notiz in neuem Fenster". | File > New Window (⇧⌘N) und Notiz in neuem Fenster/neuer Szene. | Mehrszene aktivieren, Szenen-Konfiguration pro Fenster, `requestSceneSessionActivation`; Notiz-ID je Szene. Architektur-Änderung. | L | P1 |
| W3 | Möglicherweise sichtbarer, wirkungsloser "New Window"-Eintrag: `AppDelegate.mm:254-257` lässt `UIMenuNewScene` bewusst stehen, weil es im iOS-26-SDK der Altname von `UIMenuNewItem` ist. Bei Mehrfachfenster = aus wäre der Eintrag tot. | Kein Menüpunkt ohne Funktion. | `UIMenuNewScene`/`UIMenuNewItem` explizit entfernen solange W2 fehlt. *unverifiziert (Laufzeit).* | S | P2 |
| W4 | Kein Fenstertitel/Untertitel: `SceneDelegate.m:36` `titleVisibility = UITitlebarTitleVisibilityHidden`; Toolbar `IconOnly` (`VeyraNMacToolbar.m:166`). Der Nutzer sieht nirgends, welche Notiz offen ist. | Fenstertitel = Bereich/Notizname, Untertitel = Notebook/Speicherstatus. | `titleVisibility=Visible`; Titel/Untertitel per Bridge aus JS (`NativeModules.VeyraNMacMenu`) setzen. | M | P2 |
| W5 | Keine Toolbar-Anpassung: `VeyraNMacToolbar.m:166-167` (`displayMode=IconOnly`, `allowsUserCustomization=NO`) und `toolbarAllowedItemIdentifiers` = Default (`:345-350`). | NSToolbar konfigurierbar (optional, aber Standard auf dem Mac). | `allowsUserCustomization=YES`; Flexible-Space/Separator in Allowed aufnehmen. | S | P3 |
| W6 | Kein Tracking-Separator und keine Sidebar-Vibrancy: `SceneDelegate.m:38` `separatorStyle=None`; im ganzen iOS-Projekt kein `NSVisualEffectView`. | Unified-Toolbar mit dezentem Separator, Quellliste transluzentem Material (Liquid Glass). | Separator nur bei Unter-Scrollen zeigen; Sidebar über halbtransparenten Hintergrund + native `NSVisualEffectView`-Ebene. | L | P2 |
| W7 | Feste Spaltenbreiten, nicht ziehbar: `mac-layout.ts:101-110` (Sidebar 200-260, Liste 260-360, aus der Fensterbreite abgeleitet). | Ziehbarer Trenner zwischen Sidebar/Liste/Editor, Breite persistiert. | Split-Handle in RN (Drag gesteuert) oder native `UISplitViewController` mit `preferredPrimaryColumnWidth`. | L | P2 |
| W8 | Toolbar-Höhe als 52-pt-Konstante hart verdrahtet: `mac-layout.ts:52,64-65` und `packages/editor-mobile/src/utils/mac.ts:38` (52). | Reale Toolbar-Höhe verwenden. | Native Konstanten-Bridge mit gemessener `NSToolbarView`-Höhe statt Fallback. | S | P3 |

## 2. Sidebar (Quellliste)

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| S1 | Auswahl-Pille aus Theme-Akzent mit fixer Opazität 0,2 statt Systemakzent: `mac-sidebar.tsx:376-389`; kein `NSColor.controlAccentColor` im Projekt (Grep: 0). Kein "unemphasized" bei inaktivem Fenster. | Systemauswahlfarbe, grau wenn Fenster nicht aktiv. | Systemakzent per Bridge an RN; Auswahlzustand fokusabhängig rendern. | M | P2 |
| S2 | Zähler nur für All Notes/Inbox: `hooks/use-library-source-list.ts:56-71` zählt nur `allNotes`/`inbox`. | Badges auch für Favoriten, Archiv, Papierkorb. | Weitere `count()`-Queries ergänzen. | S | P2 |
| S3 | Keine Disclosure/Collapse, keine Unter-Notebooks: `mac-sidebar.tsx:278-299` rendert flache Notebook-Liste. | Aufklappbare Dreiecke, verschachtelte Notebooks, gemerkter Zustand. | Notebook-Baum aus `db.notebooks` + `DisclosureGroup`-Verhalten. | M | P2 |
| S4 | Kein Umbenennen/Drag&Drop/Sortieren in der Sidebar: `mac-sidebar.tsx` hat kein Rename/Drag; nur Kontextmenü für Notebook/Tag-Items (`:421-426`). | Umbenennen und Notizen per Drag in Notebooks ziehen. | Kontextmenü "Umbenennen" + Drag-Ziel über `UIDragInteraction`/RN-Drax. | M | P2 |
| S5 | Sidebar-Kopf nutzt eine 44-pt-Navigationsleiste: `mac-sidebar.tsx:243-260` (`IosNavBar`, `minHeight 44` in `ios-nav-bar.tsx:65`). | Quellliste hat keine eigene Navbar. | Kopf auf einen schlichten 13-pt-Text reduzieren. | S | P3 |
| S6 | Keine Tooltips bei abgeschnittenen Namen: `mac-sidebar.tsx:396-406` (`numberOfLines={1}`), kein Tooltip. | Hover-Tooltip mit vollem Namen/Notizenzahl. | `tooltipText` an die Zeile hängen. | S | P3 |

## 3. Notizliste (Mittelspalte)

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| N1 | Swipe-Actions auf dem Mac aktiv: `list-items/selection-wrapper/index.tsx:110-113` setzt `nativeMenus = Platform.OS === "ios"` (auf Catalyst true) und wickelt Notizen in `SwipeRow` (`:271-304`) → `ReanimatedSwipeable` (`components/swipe-row.tsx:89-106`). Pin/Papierkorb/Notebook per Wischgeste. | Mac kennt keine Wisch-Actions; Aktionen über Kontextmenü/Menüleiste. | `SwipeRow` nur bei `!isMacCatalyst()`; alternativ Hover-Aktionsknopf. | S | P1 |
| N2 | Keine ⌘-/⇧-Mehrfachauswahl: im gesamten App-Code kein `metaKey`/`shiftKey` (Grep: 0). Auswahlmodus nur über "…"-Menü > Select (`list-view-menu.ts:196-198`). | ⌘-Klick togglet, ⇧-Klick markiert Bereich, Ziehen markiert Rechteck. | Modifier aus Catalyst-Pointer-Events lesen (native Bridge) und `useSelectionStore` um Bereichsauswahl erweitern. | L | P1 |
| N3 | Keine Tastaturnavigation/Type-Select: kein `onKeyDown`/Arrow-Handling (Grep: 0). | Pfeiltasten zum Wandern, Enter öffnet, Buchstabe springt. | `UIKeyCommand` auf der Szene → JS; Fokuszeile im Store. | M | P1 |
| N4 | Auswahl-Highlight bleibt Akzent auch ohne Key-Fenster: `selection-wrapper/index.tsx:224-240` (immer `colors.primary.accent` @ 0,2). | Inaktives Fenster: unemphasized grau. | Fenster-/Key-Status in `useSelectionStore`/Selector. | M | P2 |
| N5 | Doppeltes Suchfeld: `header/index.tsx:214-220` rendert `IosSearchField` in der Mittelspalte, obwohl die NSToolbar bereits ein Suchfeld hat (`VeyraNMacToolbar.m:439-496`); nur der Such-Screen blendet es aus (`global-search/index.tsx:176-181`). | Ein Suchfeld — das in der Toolbar. | `IosSearchField` auf Mac unterdrücken, wenn `toolbarSearch === true`. | S | P2 |
| N6 | 44-pt-Navbar-Zeile mit 17-pt-Titel in der Liste: `header/index.tsx:149-208`. | Mac-Listenspalte hat keine eigene Navbar; Listenname gehört in die Toolbar. | Mac-Zweig ohne `IosNavBar`; Namen in Toolbar-Untertitel (siehe W4). | M | P2 |
| N7 | Gruppen-Header ohne Sortier-/Ansichtsknöpfe: `list-items/headers/section-header.tsx:87-127` (Mac-Zweig endet vor den `IconButton`s). Sortieren nur im "…"-Menü. | Sichtbarer Sortier-/Filter-Zugriff am Listenkopf. | Vorhandene IconButtons im Mac-Zweig zeigen. | S | P2 |
| N8 | Auswahl-Checkbox 35×35 (Touch): `list-items/note/index.tsx:463-476`. | Mac listet Auswahl als Highlight, keine Checkboxen. | Checkbox auf Mac weglassen. | S | P3 |
| N9 | Dichte/Typografie passt: 28-pt-Zeilen (`selection-wrapper:45-47`), 13/12 pt (`note/index.tsx:67-68`), Hairline-Separator (`selection-wrapper:209-213`). Positiv. | — | — | — | — |

## 4. Editor

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| E1 | Keine maximale Textbreite/zentrierte Spalte: `editor-mobile/src/components/editor.tsx:480` (`maxWidth:"100vw"`), 12 px Padding (`:596-612`), Titel 100 % (`title.tsx:120`). | macOS Notizen begrenzt die Textspalte (~600-700 pt, zentriert). | Im WebView bei `isMacCatalyst` `max-width: 46rem; margin: 0 auto`. | S | P1 |
| E2 | Titel 25 pt hartkodiert, keine Mac-Größe: `title.tsx:97,119`. | Mac-Titel ~17-22 pt (oder im Fenstertitel). | Mac-Titelgröße über `settings.isMacCatalyst`. | S | P2 |
| E3 | Format-Menü ohne Funktion: `AppDelegate.mm:241-386` ergänzt `UIMenuFormat` nicht; der Editor ist ein WKWebView (`editor.tsx:487` `spellCheck`), die Catalyst-Standardbefehle Fett/Kursiv/Unterstrichen laufen ins Leere. | Format > Fett/Kursiv/Unterstrichen + Absatzstile mit ⌘B/⌘I/⌘U. | `UIMenuFormat`-Befehle ergänzen, die `VeyraNMacMenu`-Kommandos an den Editor senden. *Laufzeit unverifiziert.* | M | P1 |
| E4 | Kein Suchen/Ersetzen in der Notiz: nur "Find in Notes" (⌘⇧F, `AppDelegate.mm:279-291`) und ein Toolbar-Eintrag `startSearch()` (`editor-mobile/src/components/header.tsx:393`). Ersetzen existiert (`packages/editor/src/toolbar/popups/search-replace.tsx`), aber ohne Shortcut. | ⌘F suchen, ⌘⌥F Suchen & Ersetzen, ↩/⇧↩ navigieren. | Edit-Menü Find/Find & Replace → Editor-Commands, `Cmd-F`-Keymap im WebView. | M | P1 |
| E5 | Kein Drucken: kein `window.print(`/`.print(` im Repo (Grep: 0 Treffer). | File > Print (⌘P) mit Druckansicht. | Menüpunkt + WebView-Print; Entitlement `com.apple.security.print` ergänzen. | M | P2 |
| E6 | Kein Export/Import im File-Menü: `AppDelegate.mm:248-262` entfernt die Document-Befehle; Export existiert nur in den Einstellungen. | File > Exportieren/Importieren (PDF/HTML/Markdown). | Menüpunkte + vorhandene Export-/Import-Wege. | M | P2 |
| E7 | Kein Drag&Drop von Dateien/Bildern in den Editor: kein `onDrop`/`dragOver` (Grep: 0). | Bilder/Dateien ziehen, Vorschau, Drop-Ziel. | DnD-Handler im WebView + `EditorEvents.attachment`. | M | P2 |
| E8 | Editor-Header-Buttons 25 pt / 40 px (Touch): `editor-mobile/src/components/header.tsx:217,285,300`; die Mac-Maße (`utils/mac.ts:41-44`, Icon 16, Button 28) werden dort nicht genutzt. | 16-18 pt Toolbar-Icons, 24-28 pt Ziele. | `MAC_TOOLBAR_ICON_SIZE`/`MAC_TOOLBAR_BUTTON_SIZE` verwenden. | S | P2 |
| E9 | Rechtschreibprüfung vorhanden (`editor.tsx:487`), Textsubstitutionen/Datenprüfer nicht erkennbar. | macOS-Substitutionen greifen im Textfeld. | `WKWebView`-Konfiguration prüfen. *unverifiziert.* | S | P3 |

## 5. Menüs & Tastatur

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| K1 | File-Menü fast leer: `AppDelegate.mm:264-275` nur "New Note" (⌘N). Es fehlen Neu (Notebook/Aufgabe), Import/Export, Drucken, Teilen, Schließen. | Vollständiges File-Menü. | Befehle + JS-Handler ergänzen. | M | P1 |
| K2 | Format-Menü nicht abgedeckt. Siehe E3. | Format-Menü für Text. | Siehe E3. | M | P1 |
| K3 | Keine Suchen/Ersetzen-Kürzel im Edit-Menü. Siehe E4. | ⌘F / ⌘⌥F. | Siehe E4. | M | P1 |
| K4 | Menüpunkte ohne Validierung bleiben aktiv: `AppDelegate.mm:224-227` sagt ausdrücklich, Pin/Favorit/Papierkorb bleiben enabled, JS ignoriert sie ohne offene Notiz. | Nicht anwendbare Befehle ausgegraut. | Fokus-/Notizstatus an die Bridge melden, Menü neu bauen. | M | P2 |
| K5 | Kein Fenster-/Hilfe-Menü: kein Help-Book (`CFBundleHelpBookFolder` fehlt in `Info.plist`), Window-Menü bleibt Catalyst-Default. | "VeyraN Help" + Standard-Window-Menü. | Help-Book registrieren. | M | P3 |
| K6 | Kein "Neues Notebook"/"Neue Aufgabe"-Shortcut; ⇧⌘N unbenutzt. | ⇧⌘N = Neues Notebook. | Menüpunkt + Handler. | S | P2 |
| K7 | Kein Fokusring/Volltastaturzugriff: kein `focusRing`/`tabIndex`/`onFocus` (Grep: 0). | Systemeinstellung "Tastaturnavigation" wirkt; Tab durchläuft alle Controls. | RN-`Pressable`-Fokus + native Fokusringe. | L | P2 |
| K8 | Vorhanden und korrekt: ⌘1/2/3 (Library/Tasks/Search), ⌃⌘S Sidebar (`AppDelegate.mm:324-385`), ⌘⌫ Move to Trash (`:310-312`), ⌘, Settings (`:349-362`) — aber Sidebar-Umschalten ohne Animation (`use-mac-menu-commands.ts:195-199`). | — | Übergang animieren. | S | P3 |

## 6. Modals, Sheets, Popover

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| D1 | 37 Stellen öffnen iOS-Bottom-Sheets: `services/event-manager.ts:160-165` → `components/ui/sheet/index.jsx:133-177` (`react-native-actions-sheet`), 600 pt breit (`:67-73`), oben 24 pt gerundet (`:76-77`), iOS-Grab-Indicator (`:139-144`). | macOS-Sheet am Fenster, Inspector, Popover oder Kontextmenü. | Mac-Zweig in `SheetWrapper`: zentriertes Panel/`UIModalPresentationFormSheet` bzw. Popover. | L | P1 |
| D2 | Einstellungen sind ein Modalsheet: `navigation-stack.tsx:152-156` (`presentation: "modal"` auf iOS/Mac); geöffnet über ⌘, (`use-mac-menu-commands.ts:191-194`) und `screens/settings/home.tsx:56-71` (iOS-"Done"-Balken). | Eigenes Einstellungen-Fenster (⌘,) mit Toolbar-Tabs. | Szenen-/Panel-basiertes Einstellungen-Fenster. | L | P1 |
| D3 | Task-Detail als Form-Sheet mit iOS-Kopf: `navigation-stack.tsx:164-168`; Cancel/Done wie Reminders auf iOS. | Mac-Sheet/Panel mit Toolbar. | Mac-Kopf/Toolbar statt iOS-Done. | M | P2 |
| D4 | `Modal presentationStyle="pageSheet"` in drei Screens: `screens/tasks/detail.tsx:1453-1456`, `tasks/favorites-editor.tsx:119`, `tasks/list-customization.tsx:78`. | Popover/Sheet. | Auf `presentSheet`/Popover umstellen. | S | P2 |
| D5 | `ActionSheetIOS` auf dem Mac: `screens/tasks/detail.tsx:394-412` (Änderungen verwerfen) und `:514-529` (Löschen), inkl. Popover-Anker-Sonderfall `isMacCatalyst()`. | NSAlert/Sheet. | Mac-Zweig mit nativer Alert-Bridge. | S | P2 |
| D6 | `Alert.alert` in 7 Dateien: `settings/settings-data.tsx`, `settings/logout.ts`, `tasks/index.tsx`, `tasks/favorites-editor.tsx`, `tasks/detail.tsx`, `tasks/list-customization.tsx`, `share/share.tsx`. | Native macOS-Alerts. | Eine zentrale Alert-Bridge. | S | P2 |
| D7 | Sheet-Overlay/Backdrop-Handling ist touch-orientiert (`closeOnTouchBackdrop`, `components/ui/sheet/index.jsx:150`). | Klick außerhalb schließt, aber ohne Touch-Semantik. | Mit D1 erledigt. | S | P3 |

## 7. Controls & Typografie

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| C1 | 44-pt-Touch-Ziele überall: `ios-nav-bar.tsx:166-172` (`minWidth/minHeight: 44`), `ui/icon-button/index.tsx:96-105` (40×40 + hitSlop 10/30), 17 Stellen mit expliziten 44 pt (Grep). | Mac-Controls 20-28 pt, größere Icons sind erlaubt, aber keine 44-pt-Hit-Slops. | Mac-Größen-Token einführen. | S | P2 |
| C2 | 34-pt-Large-Title in Tasks: `screens/tasks/index.tsx:924` und `:1384` (`IosLargeTitle`). | Mac kennt keine Large Titles. | Mac-Zweig mit 17-pt-Titel/Toolbar. | S | P1 |
| C3 | iOS-Kacheln in Tasks (26-pt-Zahl, 16-pt-Label, runde Symboltiles): `tasks/index.tsx:879-903`. | Kompakte Mac-Zeilen/Karten. | Mac-Layout für Favoritenübersicht. | M | P2 |
| C4 | Intro als iPhone-Willkommensseite (34-pt-Titel, 88-px-Icon, 50-pt-Buttons): `components/intro/index.tsx:91-169`. | Schlichtes Mac-Willkommensfenster. | Mac-Variante des Intro. | M | P2 |
| C5 | iOS-Switche statt `NSSwitch`: `Switch`/`ToggleSwitch` u. a. `screens/settings/section-item.tsx:502,518`, `components/sheets/publish-note/index.tsx`, `screens/tasks/detail.tsx`. | NSSwitch-Optik. | Mac-Schalter-Stil. | M | P2 |
| C6 | Kein Zeiger-Cursor: kein `cursor:`/Pointing-Hand im App-Code (Grep: 0); `Pressable` zeigt den Standardpfeil. | Hand-Cursor über Buttons/Links. | Native `NSCursor.pointingHand` über Hover-Region. | M | P2 |
| C7 | Tooltips nur in der NSToolbar: `VeyraNMacToolbar.m:398,454,574`. In-App-Buttons haben nur `accessibilityLabel` (`ios-nav-bar.tsx:162`). | Hover-Tooltips an allen Bar-Buttons. | `toolTip`/`NativeTooltip` ergänzen. | M | P2 |
| C8 | Hover-Feedback vorhanden: `components/mac-hover.tsx`, eingebaut in Sidebar, Listen, Navbar, IconButton, Menübutton. Positiv. | — | — | — | — |
| C9 | Rechtsklick-Kontextmenüs vorhanden (`VeyraNMenu.swift:161-226`), aber nur für Notiz-/Notebook-/Tag-Zeilen (`selection-wrapper:257-267`, `mac-sidebar:421-426`). Für Sidebar-Destinationen (All Notes, Favoriten …) und die Note-List-Sektion fehlen Einträge wie "Neue Notiz", "Sortieren". | Kontextmenü überall, wo es Aktionen gibt. | Kontextmenüs ergänzen. | S | P3 |
| C10 | Ansicht/Sortieren nur im "…"-Menü, kein Toggle in Toolbar/View-Menü: `list-view-menu.ts:99-108`. | View-Menü/Toolbar-Toggle. | Menüpunkte ergänzen. | S | P3 |

## 8. Farben & Materialien

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| F1 | Kein Systemakzent: Akzent kommt aus dem Theme (`apple-visual-tokens.ts:37-128`, `mac-sidebar.tsx:394`); `NSColor.controlAccentColor` nirgends (Grep: 0). | Akzent folgt den Systemeinstellungen. | Systemakzent per Bridge, Theme-Akzent nur als Override. | M | P2 |
| F2 | Hartkodierte iOS-Dunkelfarben werden auf dem Mac angewendet: `apple-visual-tokens.ts:30-35` (`#000000/#1C1C1E/#3A3A3C/#38383A`) und `:112-127`, weil `ios = Platform.OS === "ios"` (`:41`) auf Catalyst `true` ist. Der Mac bekommt iOS-`systemGroupedBackground` (Schwarz) statt macOS-Fensterfarben. | Semantische macOS-Farben, Sidebar mit Material. | `isMacCatalyst`-Zweig in `getAppleVisualTokens` mit eigenen Mac-Tokens. | M | P1 |
| F3 | Suchfeld hartkodiert: `ios-nav-bar.tsx:299` (`#1C1C1E` im Dark, `rgba(118,118,128,0.12)`). | `NSColor.controlBackgroundColor`/`quaternaryLabelColor`. | Tokens verwenden. | S | P2 |
| F4 | Keine Materialien/Vibrancy im Inhalt: im iOS-Projekt kein `NSVisualEffectView` (Grep: 0). Toolbar ist nativ, Inhalt durchgehend opak. | Transluzente Toolbar/Sidebar (Liquid Glass). | Sidebar/Chrome auf Material umstellen. | L | P2 |
| F5 | Sidebar-/Listenflächen opak: `mac-sidebar.tsx:236`, `fluid-panels-view.tsx:455-457`. | Source-List-Material. | Mit F4. | M | P2 |
| F6 | Einzelne hartkodierte Farben: `note/index.tsx:298` (`color="orange"` für Favorit), `selection-wrapper:278,297` (Swipe-Farben), `intro/index.tsx:166` (`#FFFFFF`). | Semantische Systemfarben. | `systemColor(...)` verwenden. | S | P3 |

## 9. Mac-Systemintegration

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| I1 | Kein Einstellungen-Fenster (⌘, öffnet ein Sheet). Siehe D2. | Eigenes Fenster. | Siehe D2. | L | P1 |
| I2 | Kein Services-/Teilen-Menü: kein `UIActivityViewController`/Services (Grep: 0); `share/share.tsx` nutzt die eigene Share-Extension. | "Dienste"- und "Teilen"-Menü, Notiz/Text teilen. | `UIActivityViewController` im Popover + Services. | M | P2 |
| I3 | Kein Dock-Menü: kein `applicationDockMenu:` (Grep: 0). | Dock-Menü (Neue Notiz/Aufgabe). | `applicationDockMenu:` in `AppDelegate`. | S | P3 |
| I4 | Keine Spotlight-Integration: kein CoreSpotlight (Grep: 0). | Notizen über Spotlight finden. | `CSSearchableIndex` für Titel/Tags. | L | P3 |
| I5 | Kein (ausgehendes) Handoff: `NSUserActivity` nur eingehend (`SceneDelegate.m:60-66,90-96`), kein `becomeCurrent`. | Handoff der offenen Notiz. | `userActivity.becomeCurrent()`. | M | P3 |
| I6 | Keine Quick-Look-Vorschau: kein `QLPreview` (Grep: 0). | Leertaste zeigt Vorschau von Anhängen/Export. | QLPreviewPanel. | M | P3 |
| I7 | Kein Drag-Out von Notizen als Datei: kein `UIDragInteraction` im App-Code (Grep: 0). | Notiz/Notizblock in Finder/Mail ziehen. | `UIDragInteraction` mit Text/HTML-Item-Provider. | L | P2 |
| I8 | Nur `.nnbackup` als Dokumenttyp: `Info.plist:16-28`; keine `.md`/`.txt`/`.html`-Zuordnung. | Gängige Textformate öffnen/importieren. | `CFBundleDocumentTypes` + Importpfad. | M | P2 |
| I9 | Hardened Runtime nicht gesetzt: `ENABLE_HARDENED_RUNTIME` in `apps/mobile/ios` nicht gefunden (Grep: 0). | Mac-App-Store-/Notarisierungsanforderung. | `ENABLE_HARDENED_RUNTIME=YES` für die macOS-Konfiguration. *unverifiziert, ob extern gesetzt.* | S | P1 |
| I10 | Sandbox-Entitlements vorhanden und plausibel: `Notesnook-macOS.entitlements:7-22` (App Sandbox, Netzwerk-Client, Fotos, App Group, Keychain). Für Drucken fehlt `com.apple.security.print` (siehe E5). | Vollständige Entitlements. | Entitlement ergänzen. | S | P2 |
| I11 | Kein Help-Book. Siehe K5. | Hilfe-Menü mit Buch. | Help-Book registrieren. | M | P3 |
| I12 | Keine Menüleisten-Extra/Schnellnotiz-StatusItem (optional). | optional. | `NSStatusItem` + Schnellnotiz. | M | P3 |

## 10. Onboarding / Login

| ID | Befund | Apple-Soll | Fix | Aufwand | Prio |
|----|--------|-----------|-----|---------|------|
| O1 | Intro ist eine iPhone-Willkommensseite (zentriert, 88-px-Icon, 34-pt-Titel, 50-pt-Button): `components/intro/index.tsx:43-195`. | Schlichtes Mac-Willkommensfenster (Icon, 1-2 Zeilen, "Weiter"). | Mac-Variante des Intro. | M | P2 |
| O2 | Keine Mac-Sonderbehandlung im Auth-Bereich: `isMacCatalyst` kommt in `components/auth/*` nicht vor (Grep: 0 Treffer). Formulare laufen im iOS-Layout. | Mac-Formularbreiten/Kontrollen. | Mac-Zweig in Auth/Login. | M | P2 |
| O3 | Onboarding/Editor teilen sich Fenstergrößen-Annahmen (kein eigenes Fenster, siehe W2); kein "letzte Sitzung fortsetzen". | Fenster-/Sitzungswiederherstellung. | Mit W1/W2. | S | P3 |

---

## Top 15 — nächste Schritte (nach Wirkung sortiert)

1. **Sheets ent-iOS-en (D1):** Mac-Zweig in `components/ui/sheet/index.jsx` — zentriertes Panel/`formSheet` statt Bottom-Sheet mit Grab-Indicator und 24-pt-Ecken. Betrifft 37 Aufrufstellen. *(P1, L)*
2. **Einstellungen als eigenes Fenster (D2/I1):** ⌘, öffnet ein Fenster mit Toolbar-Tabs, nicht ein Modalsheet mit "Done". *(P1, L)*
3. **Swipe-Actions auf dem Mac abschalten (N1):** `SwipeRow` in `selection-wrapper/index.tsx` nur außerhalb von Mac verwenden. *(P1, S)*
4. **iOS-Dunkelfarben auf dem Mac ersetzen (F2):** `isMacCatalyst`-Zweig in `apple-visual-tokens.ts` mit macOS-semantischen Farben. *(P1, M)*
5. **Large Titles & 44-pt-Ziele entfernen (C2/C1):** Tasks-Titel und alle Bar-Buttons auf Mac-Maße. *(P1/P2, S)*
6. **Tastatur & Mehrfachauswahl (N2/N3/K7):** ⌘-/⇧-Klick, Pfeiltasten, Fokusringe. *(P1, L)*
7. **Editor-Spalte begrenzen (E1):** zentrierte Textspalte mit `max-width`. *(P1, S)*
8. **Suchen & Ersetzen + Format-Menü (E3/E4/K2/K3):** ⌘F/⌘⌥F und Format-Befehle mit dem Editor verbinden. *(P1, M)*
9. **Systemakzent & Vibrancy (F1/F4/W6):** Akzent aus Systemeinstellungen, Sidebar-Material. *(P2, L)*
10. **Mehrfachfenster + Wiederherstellung (W1/W2):** Standardgröße, Fenstergröße merken, File > Neues Fenster. *(P1/P2, L)*
11. **Fenstertitel/Untertitel (W4):** Notizname/Notebook in der Titelzeile. *(P2, M)*
12. **Menü-Validierung & mehr File-Befehle (K4/K1/K6):** Menüpunkte ausgrauen, Neu/Import/Export/Druck. *(P2, M)*
13. **Drag&Drop rein und raus (E7/I7):** Dateien in den Editor, Notizen in den Finder. *(P2, L)*
14. **Tooltips, Cursor, Switche (C5/C6/C7):** Mac-Kontrollen und Hover-Details. *(P2, M)*
15. **App-Store-Härtung (I9/I8):** Hardened Runtime und Dokumenttypen nachziehen. *(P1/P2, S-M)*

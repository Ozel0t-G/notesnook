# WP07 · Tastatur, Fokus und Mehrfachauswahl

**Status:** offen · **Befunde:** 3 (P1×2 · P2×1) · **Abhängig von:** WP06

## Ziel

Die Liste ist komplett per Tastatur bedienbar: Pfeile, Enter, Type-Select, ⌘A. ⌘-/⇧-Klick wählt mehrere Notizen. Tab durchläuft Sidebar, Liste und Editor mit sichtbarem Fokusring.

## Vorgehen

1. `UIKeyCommand`s für ↑ ↓ ↩ ⌫ auf Szenenebene und Weitergabe an JS (gleicher Emitter wie `VeyraNMacMenu`).
2. Fokuszeile im Store (`useSelectionStore`). Bereichsauswahl mit ⇧, Umschalten mit ⌘. Modifier aus Pointer-Events über eine native Bridge lesen (`UIEvent.modifierFlags`).
3. Fokusreihenfolge: Sidebar → Liste → Editor. Fokusring über `UIFocusSystem` bzw. RN-Fokus.

## Abnahmekriterien

- [ ] Ohne Maus: ↓ wählt die nächste Notiz und öffnet sie im Editor, ⌘⌫ verschiebt sie in den Papierkorb.
- [ ] ⇧-Klick wählt einen Bereich, die Toolbar zeigt „3 ausgewählt“.
- [ ] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### N2

- **Prio:** P1 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Keine ⌘-/⇧-Mehrfachauswahl: im gesamten App-Code kein `metaKey`/`shiftKey` (Grep: 0). Auswahlmodus nur über "…"-Menü > Select (`list-view-menu.ts:196-198`).
- **So macht es macOS:** ⌘-Klick togglet, ⇧-Klick markiert Bereich, Ziehen markiert Rechteck.
- **Fix:** Modifier aus Catalyst-Pointer-Events lesen (native Bridge) und `useSelectionStore` um Bereichsauswahl erweitern.
- [ ] erledigt

#### N3

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Keine Tastaturnavigation/Type-Select: kein `onKeyDown`/Arrow-Handling (Grep: 0).
- **So macht es macOS:** Pfeiltasten zum Wandern, Enter öffnet, Buchstabe springt.
- **Fix:** `UIKeyCommand` auf der Szene → JS; Fokuszeile im Store.
- [ ] erledigt

#### K7

- **Prio:** P2 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Kein Fokusring/Volltastaturzugriff: kein `focusRing`/`tabIndex`/`onFocus` (Grep: 0).
- **So macht es macOS:** Systemeinstellung "Tastaturnavigation" wirkt; Tab durchläuft alle Controls.
- **Fix:** RN-`Pressable`-Fokus + native Fokusringe.
- [ ] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

_(nach Abschluss ausfüllen: was geändert wurde, Commits, offene Punkte)_

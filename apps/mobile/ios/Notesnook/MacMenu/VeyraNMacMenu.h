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

#import <React/RCTEventEmitter.h>

#if TARGET_OS_MACCATALYST
#import <UIKit/UIKit.h>
#endif

/**
 * Forwards Mac Catalyst commands to JavaScript as the "VeyraNMacMenuCommand"
 * event, with the body { command, text }. The sources are AppDelegate's
 * UIMenuBuilder ("newNote", "findInNotes", "pinNote", "toggleFavorite",
 * "moveToTrash", "section:library", "section:tasks", "section:search",
 * "openSettings" and "escape") and the window toolbar
 * (MacMenu/VeyraNMacToolbar.{h,m}: "listOptions", "newNote", "newTask",
 * "shareNote", "noteInfo", "noteMore", and the toolbar search field's
 * "search"/"searchSubmit" commands, whose payload is the field's text).
 *
 * Also carries the reverse direction: `setSelectedSection`, which JS calls
 * when the app changes sections on its own (the sections are sidebar sections
 * now, so only the toolbar's New item and the search focus follow) and
 * `setWindowTitle:subtitle:`, which puts the current note or list into the
 * window title. Its `toolbarSearch` constant tells JS whether the window
 * toolbar carries the search field (Mac Catalyst 16 and newer), in which case
 * the Search screen hides its own field, and its `toolbarHeight` constant the
 * toolbar's measured height in points (0 until it could be measured;
 * `getToolbarHeight` then measures it on the main queue).
 *
 * Only fed on Mac Catalyst, but the module compiles (and stays inert) on iOS
 * as well, so the JS side can look it up unconditionally.
 *
 * It also carries the window appearance: `setWindowAppearance` mirrors the
 * app's own theme onto the window chrome, which the system would otherwise
 * keep in the *system* appearance (the toolbar, search field and traffic
 * lights all follow it).
 *
 * The second reverse direction is the system state the Mac look adapts to:
 * the "VeyraNMacSystemState" event, with the body { accent, active } - the
 * user's accent colour as "#RRGGBB" and whether the app's window counts as
 * active, i.e. whether a selection is drawn emphasised or grey. It is sent
 * while JS listens, on every window key / app activation change and when
 * AppKit reports a changed system colour, and only when a value really
 * changed; the same pair is the `systemAccent` and `windowActive` constants
 * (read once during launch, when there may not be a window yet) and can be
 * asked for on demand with `getSystemState`, which always samples the window
 * that is on screen now.
 */
@interface VeyraNMacMenu : RCTEventEmitter <RCTBridgeModule>

/**
 * Sends the command's payload with it. `text` may be nil for commands that
 * carry none. No-op when the module has no live instance or JS is not
 * observing the event.
 */
+ (void)sendCommand:(NSString *)command text:(NSString *)text;

/**
 * Sends a command without a payload. No-op when the module has no live
 * instance or JS is not observing the event.
 */
+ (void)sendCommand:(NSString *)command;

#if TARGET_OS_MACCATALYST
/**
 * Applies the appearance last set by `setWindowAppearance:` to every window of
 * `scene`. SceneDelegate calls this while it builds the scene so a window that
 * is created after (or before) JS has spoken already carries the app's theme
 * instead of the system's.
 *
 * Main thread only (`UIWindow.overrideUserInterfaceStyle` is UI state). The
 * appearance is remembered in a static, so "system" (the default) restores
 * system-following behaviour rather than pinning the last concrete style.
 */
+ (void)applyWindowAppearanceToWindowScene:(UIWindowScene *)scene;
#endif

@end

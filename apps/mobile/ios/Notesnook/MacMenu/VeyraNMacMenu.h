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

/**
 * Forwards Mac Catalyst commands to JavaScript as the "VeyraNMacMenuCommand"
 * event, with the body { command, text }. The sources are AppDelegate's
 * UIMenuBuilder ("newNote", "findInNotes", "pinNote", "toggleFavorite",
 * "moveToTrash", "section:library", "section:tasks", "section:search",
 * "openSettings" and "escape") and the window toolbar
 * (MacMenu/VeyraNMacToolbar.{h,m}: "newNote", "newTask", the same three
 * "section:" commands, and the toolbar search field's "search"/"searchSubmit"
 * commands, whose payload is the field's text).
 *
 * Also carries the reverse direction: `setSelectedSection`, which JS calls
 * when the app changes sections on its own so the toolbar's segmented control
 * follows. Its `toolbarSearch` constant tells JS whether the window toolbar
 * carries the search field (Mac Catalyst 16 and newer), in which case the
 * Search screen hides its own field.
 *
 * Only fed on Mac Catalyst, but the module compiles (and stays inert) on iOS
 * as well, so the JS side can look it up unconditionally.
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

@end

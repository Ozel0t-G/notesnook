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
 * Forwards Mac Catalyst menu bar commands ("newNote", "openSettings" and
 * "escape") from AppDelegate's UIMenuBuilder to JavaScript as the
 * "VeyraNMacMenuCommand" event.
 *
 * Only fed on Mac Catalyst, but the module compiles (and stays inert) on iOS
 * as well, so the JS side can look it up unconditionally.
 */
@interface VeyraNMacMenu : RCTEventEmitter <RCTBridgeModule>

/**
 * Sends a command to JS. No-op when the module has no live instance or JS is
 * not observing the event.
 */
+ (void)sendCommand:(NSString *)command;

@end

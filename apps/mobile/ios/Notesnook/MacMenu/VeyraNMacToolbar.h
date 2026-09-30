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

#import <Foundation/Foundation.h>

#if TARGET_OS_MACCATALYST

#import <UIKit/UIKit.h>

/**
 * The Mac window's native toolbar, shown in the unified title bar of the
 * Catalyst window (UITitlebarToolbarStyleUnified).
 *
 * It carries the three top-level sections as a segmented control (Library /
 * Tasks / Search) and a New Note button. Both report to JavaScript through
 * [VeyraNMacMenu sendCommand:]: the sections as "section:library",
 * "section:tasks" and "section:search", the button as "newNote" - the same
 * command the File menu's Cmd-N item sends.
 *
 * Installing it also stops the macOS title bar material from floating over the
 * React content: Catalyst lays the window's content out below the toolbar, so
 * the app's own headers (the list's nav bar and the editor's 52pt web header)
 * start under it instead of underneath a translucent band.
 *
 * The implementation is Catalyst-only, but the file compiles on iPhone and iPad
 * as well, so the single Notesnook target can link it everywhere.
 */
@interface VeyraNMacToolbar : NSObject <NSToolbarDelegate>

/**
 * Builds the toolbar and puts it on `windowScene.titlebar` (title hidden,
 * unified style, no separator).
 *
 * The caller must keep the returned object alive - NSToolbar's delegate is a
 * weak reference, so an unowned delegate would drop the items right after
 * `titlebar.toolbar` is set. SceneDelegate holds it for the scene's lifetime.
 */
- (instancetype)initWithWindowScene:(UIWindowScene *)windowScene;

/**
 * Moves the segmented control's selection to `section` ("library", "tasks" or
 * "search") without going through the toolbar, for section changes the window
 * chrome did not make itself (the section store, deep links, the tab bar).
 *
 * Called from JavaScript through VeyraNMacMenu. Hops to the main queue and is a
 * no-op when no toolbar is alive, so it is safe from the module's queue.
 */
+ (void)setSelectedSection:(NSString *)section;

@end

#endif

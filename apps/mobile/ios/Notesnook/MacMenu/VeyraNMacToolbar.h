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
 * Catalyst window (UITitlebarToolbarStyleUnified) as the app's single chrome
 * band (Apple Notes style).
 *
 * Item order: the list's "Sort & View" menu and the New item lead, a flexible
 * space pushes the editor actions (Share, Note Info, More) and the search field
 * to the trailing side, with the field at the far right. Every action reports
 * to JavaScript through [VeyraNMacMenu sendCommand:]: "listOptions",
 * "shareNote", "noteInfo", "noteMore", "newNote" (the same command the File
 * menu's Cmd-N item sends) or "newTask" in the Tasks section, where it does
 * what the Tasks screen's own "+ New Task" row does, and the search field as
 * "search" (every keystroke, and the start of an edit) or "searchSubmit"
 * (Return), both carrying the field's text (see +sendCommand:text:).
 *
 * It no longer carries the top-level sections (Library / Tasks / Search); they
 * live in the sidebar now. +setSelectedSection: therefore only remembers the
 * section - it keeps the New item on "New Note" / "New Task" and sends the
 * Search section's focus to the search field - and nothing is mirrored back to
 * the toolbar.
 *
 * Installing it also stops the macOS title bar material from floating over the
 * React content: Catalyst lays the window's content out below the toolbar, so
 * the app's own headers start under it instead of under a translucent band.
 *
 * The implementation is Catalyst-only, but the file compiles on iPhone and iPad
 * as well, so the single Notesnook target can link it everywhere.
 */
@interface VeyraNMacToolbar : NSObject <NSToolbarDelegate>

/**
 * Builds the toolbar and puts it on `windowScene.titlebar` (unified style, no
 * separator). The title is left to the window (see +setWindowTitle:subtitle:
 * and SceneDelegate, which shows it).
 *
 * The caller must keep the returned object alive - NSToolbar's delegate is a
 * weak reference, so an unowned delegate would drop the items right after
 * `titlebar.toolbar` is set. SceneDelegate holds it for the scene's lifetime.
 */
- (instancetype)initWithWindowScene:(UIWindowScene *)windowScene;

/**
 * Remembers `section` ("library", "tasks" or "search") without going through
 * the toolbar, for section changes the window chrome did not make itself (the
 * sidebar, the section store, deep links). It moves the leading action item to
 * that section's action ("New Note" / "New Task") and, for Search, puts the
 * cursor in the toolbar's field - the way picking Search used to.
 *
 * Called from JavaScript through VeyraNMacMenu. Hops to the main queue and is a
 * no-op when no toolbar is alive, so it is safe from the module's queue.
 */
+ (void)setSelectedSection:(NSString *)section;

/**
 * Sets the window title and subtitle (the note or list name and its context)
 * on every connected window scene. Called from JavaScript through
 * VeyraNMacMenu's `setWindowTitle:subtitle:`; the window has to show its
 * title for that to be visible (UITitlebarTitleVisibilityVisible), which
 * SceneDelegate does.
 *
 * Hops to the main queue (scene state is UI state) and is safe from the
 * module's queue. An empty or nil `title` clears it; an empty `subtitle` hides
 * the subtitle, the way UIKit documents both.
 */
+ (void)setWindowTitle:(NSString *)title subtitle:(NSString *)subtitle;

/**
 * The window toolbar's last measured height in points, or 0 while it has not
 * been measurable yet (before the window was laid out). Read from any thread -
 * it returns the cached measurement - and sent to JavaScript as the
 * `toolbarHeight` constant, so the React layout can stop hard coding 52.
 */
+ (CGFloat)toolbarHeight;

/**
 * Measures the toolbar band off the top safe area of the window(s) currently on
 * screen and caches it (see +toolbarHeight). A window that is not laid out yet
 * measures 0 and leaves the last real measurement in place, so the first call -
 * before the scene has a window - answers 0.
 *
 * Main thread only, because it reads window state; JavaScript triggers a fresh
 * measurement through VeyraNMacMenu's `getToolbarHeight` when the constant was
 * still 0.
 */
+ (CGFloat)measureToolbarHeight;

/**
 * Whether the toolbar this process built carries a search field, i.e. whether
 * the Search screen's in-app title and field are redundant. The custom-view
 * toolbar item it is built from (`NSUIViewToolbarItem`) only exists on Mac
 * Catalyst 16 and newer, so on Mac Catalyst 15 the toolbar has no search field
 * and the Search screen keeps its own (see VeyraNMacMenu's `toolbarSearch`
 * constant).
 *
 * Safe to call from any thread before the toolbar is built (it simply answers
 * NO until there is one) - JS asks for it while the module is initialising.
 */
+ (BOOL)toolbarSearchAvailable;

@end

#endif

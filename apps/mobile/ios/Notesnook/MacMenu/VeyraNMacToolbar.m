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

#import "VeyraNMacToolbar.h"

#if TARGET_OS_MACCATALYST

#import <AppKit/NSToolbarItemGroup.h>

#import "VeyraNMacMenu.h"

/// Toolbar item identifiers, all namespaced to the app's own items.
static NSToolbarItemIdentifier const VeyraNSectionsIdentifier =
    @"veyran.sections";
static NSToolbarItemIdentifier const VeyraNNewNoteIdentifier =
    @"veyran.newNote";
static NSToolbarIdentifier const VeyraNToolbarIdentifier = @"veyran.main";

/**
 * The sections, in segmented-control order. The index doubles as the
 * `selectedIndex` of the group and as the suffix of the "section:" command JS
 * receives.
 */
static NSString *const VeyraNSectionNames[] = { @"library", @"tasks",
                                                @"search" };
static NSString *const VeyraNSectionLabels[] = { @"Library", @"Tasks",
                                                 @"Search" };
static NSString *const VeyraNSectionSymbols[] = { @"books.vertical",
                                                  @"checklist",
                                                  @"magnifyingglass" };
static const NSUInteger VeyraNSectionCount = 3;

/**
 * Index of `section` in `VeyraNSectionNames`, or NSNotFound.
 */
static NSUInteger VeyraNSectionIndex(NSString *section) {
  for (NSUInteger index = 0; index < VeyraNSectionCount; index++) {
    if ([VeyraNSectionNames[index] isEqualToString:section]) {
      return index;
    }
  }
  return NSNotFound;
}

@implementation VeyraNMacToolbar {
  NSToolbar *_toolbar;
  /// The newest segmented control. Recreated whenever the toolbar asks for the
  /// item again, so it is only a shortcut for the live one (see -sectionsItem).
  NSToolbarItemGroup *_sectionsItem;
  /// The section the control should show, kept here so a selection that
  /// arrives before the toolbar is built is not lost.
  NSString *_selectedSection;
}

/**
 * The live toolbar, if the scene created one. Catalyst runs a single window
 * here, so one weak reference is enough for JavaScript to reach it.
 */
static __weak VeyraNMacToolbar *currentInstance = nil;

- (instancetype)initWithWindowScene:(UIWindowScene *)windowScene {
  if (self = [super init]) {
    currentInstance = self;
    _selectedSection = VeyraNSectionNames[0];

    NSToolbar *toolbar =
        [[NSToolbar alloc] initWithIdentifier:VeyraNToolbarIdentifier];
    toolbar.delegate = self;
    // The toolbar is fixed chrome: icons only, nothing to rearrange.
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = NO;
    _toolbar = toolbar;

    // Setting a toolbar makes Catalyst lay the window's content out below it,
    // which is what keeps the title bar material off the React content.
    windowScene.titlebar.toolbar = toolbar;
    if (@available(macCatalyst 14.0, *)) {
      // Title and toolbar share one row (the sections sit where the window
      // title used to be).
      windowScene.titlebar.toolbarStyle = UITitlebarToolbarStyleUnified;
    }
  }
  return self;
}

#pragma mark - Sections

+ (void)setSelectedSection:(NSString *)section {
  // Called from the React module's queue: NSToolbar is main-thread only.
  dispatch_async(dispatch_get_main_queue(), ^{
    VeyraNMacToolbar *instance = currentInstance;
    if (instance == nil) {
      return;
    }
    [instance selectSection:section];
  });
}

- (void)selectSection:(NSString *)section {
  NSUInteger index = VeyraNSectionIndex(section);
  if (index == NSNotFound) {
    return;
  }
  _selectedSection = section;
  // The control only exists once the toolbar has been laid out; until then
  // _selectedSection is applied when the item is built.
  NSToolbarItemGroup *group = [self sectionsItem];
  if (group == nil) {
    return;
  }
  group.selectedIndex = (NSInteger)index;
}

/**
 * The segmented control currently on the toolbar, or nil before the toolbar
 * asked for it.
 */
- (NSToolbarItemGroup *)sectionsItem {
  for (NSToolbarItem *item in _toolbar.items) {
    if ([item.itemIdentifier isEqualToString:VeyraNSectionsIdentifier] &&
        [item isKindOfClass:[NSToolbarItemGroup class]]) {
      return (NSToolbarItemGroup *)item;
    }
  }
  return _sectionsItem;
}

- (void)selectSectionFromToolbar:(id)sender {
  // The group reports the click for the whole segmented control, so the new
  // selection is read off it rather than off the clicked segment.
  NSInteger index = [sender isKindOfClass:[NSToolbarItemGroup class]]
                        ? ((NSToolbarItemGroup *)sender).selectedIndex
                        : [self sectionsItem].selectedIndex;
  if (index < 0 || (NSUInteger)index >= VeyraNSectionCount) {
    return;
  }
  NSString *section = VeyraNSectionNames[index];
  _selectedSection = section;
  [VeyraNMacMenu sendCommand:[@"section:" stringByAppendingString:section]];
}

#pragma mark - Items

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)itemIdentifier
 willBeInsertedIntoToolbar:(BOOL)flag {
  if ([itemIdentifier isEqualToString:VeyraNSectionsIdentifier]) {
    return [self makeSectionsItem];
  }
  if ([itemIdentifier isEqualToString:VeyraNNewNoteIdentifier]) {
    return [self makeNewNoteItem];
  }
  return nil;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:
    (NSToolbar *)toolbar {
  // Sections on the left, the compose action on the right.
  return @[
    VeyraNSectionsIdentifier, NSToolbarFlexibleSpaceItemIdentifier,
    VeyraNNewNoteIdentifier
  ];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:
    (NSToolbar *)toolbar {
  // Nothing is customizable (allowsUserCustomization is NO); the default set is
  // the whole set.
  return [self toolbarDefaultItemIdentifiers:toolbar];
}

/**
 * The three sections as one segmented control. `selectionMode` keeps exactly
 * one segment on, and the whole group reports through a single action that
 * reads the new `selectedIndex`.
 */
- (NSToolbarItem *)makeSectionsItem {
  NSMutableArray<UIImage *> *images =
      [NSMutableArray arrayWithCapacity:VeyraNSectionCount];
  NSMutableArray<NSString *> *labels =
      [NSMutableArray arrayWithCapacity:VeyraNSectionCount];
  for (NSUInteger index = 0; index < VeyraNSectionCount; index++) {
    UIImage *image = [UIImage systemImageNamed:VeyraNSectionSymbols[index]];
    // A missing symbol would leave a blank (or crash on a nil array member):
    // circle is the oldest SF Symbol and always resolves.
    [images addObject:image ?: [UIImage systemImageNamed:@"circle"]];
    [labels addObject:VeyraNSectionLabels[index]];
  }

  NSToolbarItemGroup *group = [NSToolbarItemGroup
      groupWithItemIdentifier:VeyraNSectionsIdentifier
                       images:images
                selectionMode:NSToolbarItemGroupSelectionModeSelectOne
                       labels:labels
                       target:self
                       action:@selector(selectSectionFromToolbar:)];
  group.label = @"Sections";
  group.paletteLabel = @"Sections";
  NSUInteger selected = VeyraNSectionIndex(_selectedSection);
  group.selectedIndex = (NSInteger)(selected == NSNotFound ? 0 : selected);

  _sectionsItem = group;
  return group;
}

- (NSToolbarItem *)makeNewNoteItem {
  NSToolbarItem *item =
      [[NSToolbarItem alloc] initWithItemIdentifier:VeyraNNewNoteIdentifier];
  item.label = @"New Note";
  item.paletteLabel = @"New Note";
  item.toolTip = @"New Note";
  item.image = [UIImage systemImageNamed:@"square.and.pencil"];
  item.target = self;
  item.action = @selector(newNoteFromToolbar:);
  return item;
}

- (void)newNoteFromToolbar:(id)sender {
  // Same command as File > New Note (Cmd-N).
  [VeyraNMacMenu sendCommand:@"newNote"];
}

@end

#endif

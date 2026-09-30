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
static NSToolbarItemIdentifier const VeyraNNewItemIdentifier = @"veyran.newItem";
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
 * Leading action of each section: adding a note in Library and Search, adding a
 * Task in Tasks (the same thing the Tasks screen's own "+ New Task" row does).
 * The title, the SF Symbol and the command JavaScript receives all come from
 * these two entries.
 */
static NSString *const VeyraNNewItemTitles[] = { @"New Note", @"New Task" };
static NSString *const VeyraNNewItemSymbols[] = { @"square.and.pencil",
                                                  @"plus" };
static NSString *const VeyraNNewItemCommands[] = { @"newNote", @"newTask" };

/**
 * Index into the arrays above for `section`: the Task action in Tasks, the Note
 * action in Library and Search alike.
 */
static NSUInteger VeyraNNewItemIndex(NSString *section) {
  return [section isEqualToString:VeyraNSectionNames[1]] ? 1 : 0;
}

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
  /// The newest leading action item (see -newItem).
  NSToolbarItem *_newItem;
  /// Whether that item is the Tasks one (icon, title and command all follow
  /// this; see -applyNewItemForSection:).
  BOOL _newItemIsTask;
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
  // Both items only exist once the toolbar has been laid out; until then
  // _selectedSection is applied when they are built.
  [self applyNewItemForSection:section];
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

/**
 * The leading action item currently on the toolbar, or nil before the toolbar
 * asked for it.
 */
- (NSToolbarItem *)newItem {
  for (NSToolbarItem *item in _toolbar.items) {
    if ([item.itemIdentifier isEqualToString:VeyraNNewItemIdentifier]) {
      return item;
    }
  }
  return _newItem;
}

- (void)selectSectionFromToolbar:(id)sender {
  NSToolbarItemGroup *group = [self sectionsItem];
  // Each segment is a toolbar item of its own and reports itself through its
  // tag; when the segmented control reports for the whole group (the group is
  // its view's target), the selection is read off the group instead.
  NSInteger index = -1;
  if ([sender isKindOfClass:[NSToolbarItemGroup class]]) {
    index = ((NSToolbarItemGroup *)sender).selectedIndex;
  } else if ([sender isKindOfClass:[NSToolbarItem class]]) {
    index = ((NSToolbarItem *)sender).tag;
  } else {
    index = group.selectedIndex;
  }
  if (index < 0 || (NSUInteger)index >= VeyraNSectionCount) {
    return;
  }
  NSString *section = VeyraNSectionNames[index];
  _selectedSection = section;
  // The segments are items of the group, so the group does not move its own
  // selection: the click has to.
  [self selectIndex:(NSUInteger)index onGroup:group];
  [self applyNewItemForSection:section];
  [VeyraNMacMenu sendCommand:[@"section:" stringByAppendingString:section]];
}

/**
 * Marks `index` as the group's selected segment and clears the other ones.
 * NSNotFound (a section before the first -setSelectedSection:) falls back to
 * the first segment, which is the section the toolbar starts on.
 */
- (void)selectIndex:(NSUInteger)index onGroup:(NSToolbarItemGroup *)group {
  if (group == nil) {
    return;
  }
  if (index == NSNotFound || index >= VeyraNSectionCount) {
    index = 0;
  }
  for (NSUInteger segment = 0; segment < VeyraNSectionCount; segment++) {
    [group setSelected:segment == index atIndex:(NSInteger)segment];
  }
  group.selectedIndex = (NSInteger)index;
}

#pragma mark - Items

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)itemIdentifier
 willBeInsertedIntoToolbar:(BOOL)flag {
  if ([itemIdentifier isEqualToString:VeyraNSectionsIdentifier]) {
    return [self makeSectionsItem];
  }
  if ([itemIdentifier isEqualToString:VeyraNNewItemIdentifier]) {
    return [self makeNewItem];
  }
  return nil;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:
    (NSToolbar *)toolbar {
  // Sections on the left, the compose action on the right.
  return @[
    VeyraNSectionsIdentifier, NSToolbarFlexibleSpaceItemIdentifier,
    VeyraNNewItemIdentifier
  ];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:
    (NSToolbar *)toolbar {
  // Nothing is customizable (allowsUserCustomization is NO); the default set is
  // the whole set.
  return [self toolbarDefaultItemIdentifiers:toolbar];
}

/**
 * The three sections as one segmented control.
 *
 * Its segments are built here as individual NSToolbarItems rather than by the
 * `groupWithItemIdentifier:images:selectionMode:labels:` convenience
 * constructor: the constructor's segments are auto-created and take the name
 * VoiceOver reads straight from the SF Symbol's own description ("Books
 * standing vertically on a shelf", "Checklist with checkmarks"), which no
 * label - not on the segment item, not on its image - replaces. A group whose
 * subitems are items of its own exposes each segment's `label` instead, so
 * VoiceOver says "Library", "Tasks" and "Search".
 *
 * Because the group does not own the click (each segment carries the group's
 * action, and the group's action is what its segmented control forwards to),
 * the selection is moved by -selectIndex:onGroup: on every click and on every
 * section change; `selectionMode` and `selectedIndex` stay in sync with it.
 */
- (NSToolbarItem *)makeSectionsItem {
  NSMutableArray<NSToolbarItem *> *segments =
      [NSMutableArray arrayWithCapacity:VeyraNSectionCount];
  for (NSUInteger index = 0; index < VeyraNSectionCount; index++) {
    NSToolbarItem *segment = [[NSToolbarItem alloc]
        initWithItemIdentifier:[NSString
                                   stringWithFormat:@"%@.%lu",
                                                    VeyraNSectionsIdentifier,
                                                    (unsigned long)index]];
    UIImage *image = [UIImage systemImageNamed:VeyraNSectionSymbols[index]];
    // A missing symbol would leave a blank (or crash on a nil array member):
    // circle is the oldest SF Symbol and always resolves.
    if (image == nil) {
      image = [UIImage systemImageNamed:@"circle"];
    }
    image.accessibilityLabel = VeyraNSectionLabels[index];
    segment.image = image;
    // What VoiceOver reads for the segment, and what a tooltip shows.
    segment.label = VeyraNSectionLabels[index];
    segment.paletteLabel = VeyraNSectionLabels[index];
    segment.toolTip = VeyraNSectionLabels[index];
    // The section this segment switches to, read back off the sender.
    segment.tag = (NSInteger)index;
    segment.target = self;
    segment.action = @selector(selectSectionFromToolbar:);
    [segments addObject:segment];
  }

  NSToolbarItemGroup *group =
      [[NSToolbarItemGroup alloc] initWithItemIdentifier:VeyraNSectionsIdentifier];
  group.subitems = segments;
  group.selectionMode = NSToolbarItemGroupSelectionModeSelectOne;
  group.label = @"Sections";
  group.paletteLabel = @"Sections";
  group.toolTip = @"Sections";
  // Clicks a segmented control reports for the group itself arrive here too.
  group.target = self;
  group.action = @selector(selectSectionFromToolbar:);
  [self selectIndex:VeyraNSectionIndex(_selectedSection) onGroup:group];

  _sectionsItem = group;
  return group;
}

/**
 * The leading action of the toolbar: "New Note" (square.and.pencil) in Library
 * and Search, "New Task" (plus) in Tasks. The section decides its title,
 * symbol and the command JavaScript receives; see -applyNewItemForSection:.
 */
- (NSToolbarItem *)makeNewItem {
  NSToolbarItem *item =
      [[NSToolbarItem alloc] initWithItemIdentifier:VeyraNNewItemIdentifier];
  item.target = self;
  item.action = @selector(newItemFromToolbar:);
  _newItem = item;
  [self applyNewItemForSection:_selectedSection];
  return item;
}

/**
 * Points the leading item at `section`'s action. Called when the section
 * changes (including every change JavaScript pushes through
 * +setSelectedSection:) and while the item is built, so a section that arrives
 * before the toolbar is laid out is not lost.
 */
- (void)applyNewItemForSection:(NSString *)section {
  NSUInteger index = VeyraNNewItemIndex(section);
  _newItemIsTask = index == 1;

  NSToolbarItem *item = [self newItem];
  if (item == nil) {
    return;
  }
  // Icon-only item: the label, palette label, tool tip and the image's
  // accessibility description all have to name the action ("square.and.pencil"
  // and "plus" would otherwise be announced as the symbol's own description).
  UIImage *image = [UIImage systemImageNamed:VeyraNNewItemSymbols[index]];
  if (image == nil) {
    image = [UIImage systemImageNamed:@"plus"];
  }
  image.accessibilityLabel = VeyraNNewItemTitles[index];
  item.image = image;
  item.label = VeyraNNewItemTitles[index];
  item.paletteLabel = VeyraNNewItemTitles[index];
  item.toolTip = VeyraNNewItemTitles[index];
}

- (void)newItemFromToolbar:(id)sender {
  // "newNote" is the same command as File > New Note (Cmd-N); "newTask" is the
  // Tasks screen's own "+ New Task" row.
  [VeyraNMacMenu sendCommand:VeyraNNewItemCommands[_newItemIsTask ? 1 : 0]];
}

@end

#endif

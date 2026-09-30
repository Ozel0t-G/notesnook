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
static NSToolbarItemIdentifier const VeyraNSearchIdentifier = @"veyran.search";
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

/**
 * Search field metrics. The field is a view the toolbar is handed, not a
 * system search item, so it has to size itself: a standard search field width
 * (the one Finder and Mail give theirs) and the height of a small control. The
 * width is a constraint with a low enough priority to let the toolbar compress
 * it before clipping the item, and it is also what the item uses to measure
 * itself.
 */
static const CGFloat VeyraNSearchFieldWidth = 220;
static const CGFloat VeyraNSearchFieldHeight = 28;

/**
 * The toolbar owns the search field and is its delegate for Return
 * (-textFieldShouldReturn:); edits are reported through target/action on the
 * field itself.
 */
@interface VeyraNMacToolbar () <UITextFieldDelegate>
@end

@implementation VeyraNMacToolbar {
  NSToolbar *_toolbar;
  /// The newest segmented control. Recreated whenever the toolbar asks for the
  /// item again, so it is only a shortcut for the live one (see -sectionsItem).
  NSToolbarItemGroup *_sectionsItem;
  /// The newest search field (see -makeSearchItem), the one the toolbar is
  /// showing and the one the section click focuses.
  UISearchTextField *_searchField;
  /// What is currently typed in the search field. Held here because the field
  /// is rebuilt whenever the toolbar asks for the item again, and because the
  /// Search screen keeps its query when another section takes over.
  NSString *_searchText;
  /// Whether this process can show a search field at all (Mac Catalyst 16+).
  BOOL _searchAvailable;
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

/**
 * Whether the live toolbar carries a search field. Read by
 * +toolbarSearchAvailable (and through it by JS) from the React queue, written
 * once on the main queue while the scene connects, before React Native starts.
 */
static BOOL currentSearchAvailable = NO;

+ (BOOL)toolbarSearchAvailable {
  return currentSearchAvailable;
}

- (instancetype)initWithWindowScene:(UIWindowScene *)windowScene {
  if (self = [super init]) {
    currentInstance = self;
    _selectedSection = VeyraNSectionNames[0];
    /**
     * The toolbar's search field is a `UISearchTextField` hosted by an
     * `NSUIViewToolbarItem`: on Mac Catalyst the toolbar items are the only
     * AppKit chrome in the window and a UIKit view can only get into them
     * through that item, which exists from Mac Catalyst 16 (macOS 13) on.
     *
     * `NSSearchToolbarItem` looks like the natural fit, but AppKit marks it
     * unavailable on Mac Catalyst and its Catalyst implementation is the
     * AppKit one: its `searchField` setter messages the field as an
     * `NSSearchField` (`-cell`) and raises on a UIKit field. The custom-view
     * item above is the supported route on this platform.
     */
    if (@available(macCatalyst 16.0, *)) {
      _searchAvailable = YES;
    }
    currentSearchAvailable = _searchAvailable;
    _searchText = @"";

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
  // Picking Search puts the cursor in the toolbar's own field, the way
  // Ctrl-Cmd-F does in Mail and Finder. Other section changes never touch the
  // field, and JavaScript pushing a section back (a deep link, the section
  // store, the tab bar) does not either - only the user's click does.
  if ([section isEqualToString:VeyraNSectionNames[2]]) {
    [self focusSearchField];
  }
  [VeyraNMacMenu sendCommand:[@"section:" stringByAppendingString:section]];
}

/**
 * Makes the search field the first responder. (`NSSearchToolbarItem`'s
 * `beginSearchInteraction` is the AppKit spelling of this and is unavailable
 * on Catalyst, like the class itself; here the focus is put on the field
 * directly.) The click that switched sections arrives before the item is on
 * screen the first time, so a field that refuses focus is asked again on the
 * next runloop turn.
 */
- (void)focusSearchField {
  if (!_searchAvailable) {
    return;
  }
  if (@available(macCatalyst 16.0, *)) {
    UISearchTextField *field = _searchField;
    if (field == nil || [field becomeFirstResponder]) {
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [field becomeFirstResponder];
    });
  }
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
  if ([itemIdentifier isEqualToString:VeyraNSearchIdentifier]) {
    return [self makeSearchItem];
  }
  if ([itemIdentifier isEqualToString:VeyraNNewItemIdentifier]) {
    return [self makeNewItem];
  }
  return nil;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:
    (NSToolbar *)toolbar {
  // Sections on the left, the search field and the compose action on the
  // right (the flexible space pulls everything after it over).
  NSMutableArray<NSToolbarItemIdentifier> *identifiers = [NSMutableArray
      arrayWithObjects:VeyraNSectionsIdentifier,
                       NSToolbarFlexibleSpaceItemIdentifier, nil];
  // The field only exists where it can be built; on Mac Catalyst 15 the
  // identifier is left out rather than returned as a nil item (AppKit raises
  // on a missing item).
  if (_searchAvailable) {
    [identifiers addObject:VeyraNSearchIdentifier];
  }
  [identifiers addObject:VeyraNNewItemIdentifier];
  return identifiers;
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
 * constructor, so each segment keeps its own tag along with the group's action
 * (see -selectSectionFromToolbar:).
 *
 * Known limitation: VoiceOver still names each segment after the SF Symbol's
 * own description ("Books standing vertically on a shelf", "Checklist with
 * checkmarks"). AppKit takes an image segment's name from its NSImage's
 * `accessibilityDescription` (see -[NSSegmentedControl
 * segmentedControlWithImages:...]), but on Catalyst NSToolbarItem.image is a
 * UIImage: UIKit exposes no accessibility description for an image and no
 * public UIImage/NSImage conversion, so neither `image.accessibilityLabel` nor
 * the segment's label/paletteLabel/toolTip replaces it. The three labels are
 * still set (they are the item's label in text mode and its tooltip); nothing
 * more can be done from public API today.
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
    // The item's label in text mode and its tooltip. (Neither these nor the
    // image's accessibility label rename the segment for VoiceOver; see the
    // note on -makeSectionsItem.)
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
 * The search field, at the trailing side of the toolbar and before the New
 * button, the way Finder, Mail and Notes carry theirs.
 *
 * `NSSearchToolbarItem` is AppKit's search item, but AppKit marks it
 * unavailable on Mac Catalyst and its Catalyst implementation is the AppKit
 * one: `-setSearchField:` messages the field as an `NSSearchField` (`-cell`
 * and friends) and raises on the `UISearchTextField` this platform has. The
 * supported Catalyst equivalent is `NSUIViewToolbarItem`, which hosts a UIKit
 * view in the toolbar (Mac Catalyst 16 and newer).
 *
 * The item is rebuilt whenever the toolbar asks for it, so the text typed so
 * far is carried over from -searchFieldDidChange: through `_searchText`. The
 * field is the toolbar's own control: text goes to JS as "search" while it is
 * typed and as "searchSubmit" on Return, and JavaScript pushes the section
 * changes back (see hooks/use-mac-menu-commands.ts).
 */
- (NSToolbarItem *)makeSearchItem {
  if (!_searchAvailable) {
    // Never reached: the identifier is only handed out where the item can be
    // built (see -toolbarDefaultItemIdentifiers:), and AppKit raises on a nil
    // item.
    return nil;
  }
  if (@available(macCatalyst 16.0, *)) {
    UISearchTextField *field = [self makeSearchField];
    _searchField = field;
    NSUIViewToolbarItem *item = [[NSUIViewToolbarItem alloc]
        initWithItemIdentifier:VeyraNSearchIdentifier
                        uiView:field];
    item.label = @"Search";
    item.paletteLabel = @"Search";
    item.toolTip = @"Search";
    return item;
  }
  return nil;
}

/**
 * The field itself: a standard `UISearchTextField` (magnifier, clear button,
 * rounded search background) with its text carried over, wired to the toolbar
 * for edits and shaped by two constraints so the hosting item can measure it.
 */
- (UISearchTextField *)makeSearchField {
  CGRect frame =
      CGRectMake(0, 0, VeyraNSearchFieldWidth, VeyraNSearchFieldHeight);
  UISearchTextField *field = [[UISearchTextField alloc] initWithFrame:frame];
  field.placeholder = @"Search";
  field.returnKeyType = UIReturnKeySearch;
  field.clearButtonMode = UITextFieldViewModeWhileEditing;
  field.text = _searchText;
  field.accessibilityLabel = @"Search";
  // The item is the field's delegate only for Return (see
  // -textFieldShouldReturn:); edits are reported through target/action.
  field.delegate = self;
  [field addTarget:self
                action:@selector(searchFieldDidBeginEditing:)
      forControlEvents:UIControlEventEditingDidBegin];
  [field addTarget:self
                action:@selector(searchFieldDidChange:)
      forControlEvents:UIControlEventEditingChanged];

  // A search field has no intrinsic width, and the hosting item measures the
  // view it is given: the width constraint is what keeps the field 220 pt wide
  // in the toolbar. It yields to the field's own content compression before
  // the item would be clipped, and the height is what stops the field from
  // being stretched to the toolbar's full height.
  NSLayoutConstraint *width =
      [field.widthAnchor constraintEqualToConstant:VeyraNSearchFieldWidth];
  width.priority = UILayoutPriorityDefaultHigh;
  NSLayoutConstraint *height =
      [field.heightAnchor constraintEqualToConstant:VeyraNSearchFieldHeight];
  [NSLayoutConstraint activateConstraints:@[ width, height ]];
  return field;
}

/**
 * The user's edit began: JavaScript switches to the Search section (the field
 * is usable before the section is), with whatever the field already holds.
 */
- (void)searchFieldDidBeginEditing:(UISearchTextField *)field {
  [self sendSearchCommand:@"search" fromField:field];
}

/**
 * The field's text changed (a keystroke, the clear button, a paste). The text
 * is kept here so a rebuilt field keeps it, and sent to JavaScript; an empty
 * field keeps the Search section but empties the query.
 */
- (void)searchFieldDidChange:(UISearchTextField *)field {
  [self sendSearchCommand:@"search" fromField:field];
}

/**
 * Return in the search field. The query is already known to JavaScript (every
 * keystroke sends it); this is the explicit "run it now" the Search screen uses
 * to skip its typing debounce.
 */
- (BOOL)textFieldShouldReturn:(UITextField *)textField {
  [self sendSearchCommand:@"searchSubmit" fromField:textField];
  return YES;
}

/**
 * Sends `command` with the field's current text, and keeps that text for the
 * next field.
 */
- (void)sendSearchCommand:(NSString *)command fromField:(UITextField *)field {
  _searchText = field.text ?: @"";
  [VeyraNMacMenu sendCommand:command text:_searchText];
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

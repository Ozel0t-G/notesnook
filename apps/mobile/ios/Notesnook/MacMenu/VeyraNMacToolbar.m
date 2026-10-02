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

#import <AppKit/NSToolbarItem.h>
// NSToolbarItemGroup is a separate header: the editor actions are one group, so
// the system draws them in a single glass capsule (see
// -makeEditorActionsGroup).
#import <AppKit/NSToolbarItemGroup.h>

#import "VeyraNMacMenu.h"

/// Toolbar item identifiers, all namespaced to the app's own items.
static NSToolbarItemIdentifier const VeyraNToggleSidebarIdentifier =
    @"veyran.toggleSidebar";
static NSToolbarItemIdentifier const VeyraNSearchIdentifier = @"veyran.search";
static NSToolbarItemIdentifier const VeyraNNewItemIdentifier = @"veyran.newItem";
static NSToolbarIdentifier const VeyraNToolbarIdentifier = @"veyran.main";

/**
 * The editor actions (Share, Note Info, More) travel as one
 * `NSToolbarItemGroup`: macOS 26 draws the bordered items of a group inside a
 * single glass capsule, while three separate items would each get their own
 * circle - and since the glyphs are plain now, that is the only circle. The
 * group's own identifier is not an action; the subitems keep the action
 * identifiers and tags (see -makeEditorActionsGroup).
 */
static NSToolbarItemIdentifier const VeyraNEditorActionsIdentifier =
    @"veyran.editorActions";

/**
 * Leading "Toggle Sidebar" button. Its label and tool tip are fixed (unlike the
 * New item, which follows the section): it does one thing, and the symbol is the
 * one macOS uses for it (Finder, Mail, Notes). It reports to JavaScript as the
 * same "toggleSidebar" command View > Toggle Sidebar sends, so the sidebar pane
 * collapses through the one handler (hooks/use-mac-menu-commands.ts).
 */
static NSString *const VeyraNToggleSidebarLabel = @"Toggle Sidebar";
static NSString *const VeyraNToggleSidebarToolTip = @"Show or hide the sidebar";
static NSString *const VeyraNToggleSidebarSymbol = @"sidebar.left";
static NSString *const VeyraNToggleSidebarCommand = @"toggleSidebar";

/**
 * The toolbar's icon-only actions, in the order they appear: the list's
 * "Sort & View" menu first (it leads, next to the New item), then the three
 * editor actions, which are inserted as one group after the flexible space (see
 * -makeEditorActionsGroup). The index into these four arrays is the item's
 * `tag`, which is how -actionFromToolbar: reads the command back (an
 * NSToolbarItem carries no command string of its own).
 *
 * The symbols are the ones Apple's Mac apps use for the same actions: the
 * editor actions are plain glyphs (`info`, `ellipsis`), not their `.circle`
 * variants, because a bordered item already draws the circle and a circled
 * glyph would sit inside it as a circle within a circle. A symbol that does not
 * resolve falls back to `circle` rather than leaving a blank item (see
 * -makeActionItem:).
 */
static NSToolbarItemIdentifier const VeyraNActionIdentifiers[] = {
  @"veyran.listOptions", @"veyran.shareNote", @"veyran.noteInfo",
  @"veyran.noteMore"
};
static NSString *const VeyraNActionSymbols[] = {
  @"arrow.up.arrow.down", @"square.and.arrow.up", @"info", @"ellipsis"
};
static NSString *const VeyraNActionLabels[] = { @"Sort & View", @"Share",
                                                @"Note Info", @"More" };
static NSString *const VeyraNActionCommands[] = { @"listOptions", @"shareNote",
                                                  @"noteInfo", @"noteMore" };
static const NSUInteger VeyraNActionCount = 4;

/**
 * The top-level sections, in the order the app and JavaScript use them. The
 * toolbar no longer carries them (they are sidebar sections now), but it still
 * has to recognise them: the Tasks section turns the leading item into "New
 * Task" and Search focuses the search field (see -selectSection:).
 */
static NSString *const VeyraNSectionNames[] = { @"library", @"tasks",
                                                @"search" };
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
 * Index of `identifier` in the action arrays above, or NSNotFound.
 */
static NSUInteger VeyraNActionIndex(NSString *identifier) {
  for (NSUInteger index = 0; index < VeyraNActionCount; index++) {
    if ([VeyraNActionIdentifiers[index] isEqualToString:identifier]) {
      return index;
    }
  }
  return NSNotFound;
}

/**
 * Search field metrics. The field is a view the toolbar is handed, not a
 * system search item, so it has to size itself: a standard search field width
 * (the one Finder and Mail give theirs) and the height of the glass buttons it
 * sits next to, so its capsule matches them. The width is a constraint with a
 * low enough priority to let the toolbar compress it before clipping the item,
 * and it is also what the container uses to measure itself.
 */
static const CGFloat VeyraNSearchFieldWidth = 220;
static const CGFloat VeyraNSearchFieldHeight = 30;

/**
 * The toolbar owns the search field and is its delegate for Return
 * (-textFieldShouldReturn:); edits are reported through target/action on the
 * field itself.
 */
@interface VeyraNMacToolbar () <UITextFieldDelegate>
@end

@implementation VeyraNMacToolbar {
  NSToolbar *_toolbar;
  /// The newest search field (see -makeSearchItem), the one the toolbar is
  /// showing and the one a Search section change focuses.
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
  /// The section the app is on, kept here so a section that arrives before the
  /// toolbar is built is not lost.
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

/**
 * The window toolbar's measured height in points. Written on the main queue by
 * +measureToolbarHeight and read from the React queue by +toolbarHeight (JS
 * gets it as the module's `toolbarHeight` constant and can ask for a fresh
 * measurement through `getToolbarHeight`). 0 means "not measurable yet".
 */
static CGFloat currentToolbarHeight = 0;

+ (BOOL)toolbarSearchAvailable {
  return currentSearchAvailable;
}

+ (CGFloat)toolbarHeight {
  return currentToolbarHeight;
}

+ (CGFloat)measureToolbarHeight {
  CGFloat height = 0;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    // With a unified toolbar the window's top safe area is exactly the band the
    // toolbar (and the title shown in it) occupies, so the height does not have
    // to be guessed.
    UIWindow *window = ((UIWindowScene *)scene).windows.firstObject;
    height = MAX(height, window.safeAreaInsets.top);
  }
  // A window that is not laid out yet (or no window at all) answers 0: the last
  // real measurement is kept instead of being replaced by it, so the constant
  // and the promise do not flip back to 0 after a resize.
  if (height > 0) {
    currentToolbarHeight = height;
  }
  return currentToolbarHeight;
}

+ (void)setWindowTitle:(NSString *)title subtitle:(NSString *)subtitle {
  // Called from the React module's queue: scene title and subtitle are UI
  // state.
  dispatch_async(dispatch_get_main_queue(), ^{
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      UIWindowScene *windowScene = (UIWindowScene *)scene;
      // A nil title is documented as "the system will not display a title".
      windowScene.title = title;
      if (@available(macCatalyst 15.0, *)) {
        // The subtitle is non-null: an empty string is what hides it.
        windowScene.subtitle = subtitle ?: @"";
      }
    }
  });
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
      // Title and toolbar share one row, the way the title sits next to the
      // toolbar items in a Notes window.
      windowScene.titlebar.toolbarStyle = UITitlebarToolbarStyleUnified;
    }

    // The window the scene will show does not exist yet (SceneDelegate builds
    // the toolbar first and the window right after), and its safe area only
    // settles once it is on screen: the toolbar height is measured when the
    // window becomes key (see -windowDidBecomeKey:).
    [NSNotificationCenter.defaultCenter
        addObserver:self
           selector:@selector(windowDidBecomeKey:)
               name:UIWindowDidBecomeKeyNotification
             object:nil];
  }
  return self;
}

- (void)dealloc {
  // The notification centre does not retain its observers; leaving the
  // registration behind would be a dangling one.
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

/**
 * First moment the toolbar height is real: the window the scene shows has been
 * laid out and put on screen. The measurement is deferred one runloop turn
 * because becoming key still runs inside the layout pass that sets the safe
 * area.
 */
- (void)windowDidBecomeKey:(NSNotification *)notification {
  dispatch_async(dispatch_get_main_queue(), ^{
    [VeyraNMacToolbar measureToolbarHeight];
  });
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

/**
 * The toolbar has no segmented control since the sections moved into the
 * sidebar: only the leading item follows the section, and picking Search puts
 * the cursor in the toolbar's own field, the way Ctrl-Cmd-F does in Mail and
 * Finder and the way selecting the Search segment used to. Other section
 * changes never touch the field, and JavaScript pushing a section back (a deep
 * link, the section store) does not either - there is nothing on the toolbar to
 * mirror back.
 */
- (void)selectSection:(NSString *)section {
  NSUInteger index = VeyraNSectionIndex(section);
  if (index == NSNotFound) {
    return;
  }
  _selectedSection = section;
  // Only exists once the toolbar has been laid out; until then _selectedSection
  // is applied when the item is built.
  [self applyNewItemForSection:section];
  if ([section isEqualToString:VeyraNSectionNames[2]]) {
    [self focusSearchField];
  }
}

/**
 * The item on the toolbar carrying `identifier`, looking inside item groups as
 * well: Share, Note Info and More are subitems of one NSToolbarItemGroup now
 * (see -makeEditorActionsGroup), so a plain walk over `_toolbar.items` would
 * not see them. Keeping every identifier lookup in one place means a future
 * grouped item cannot be missed.
 */
- (NSToolbarItem *)toolbarItemWithIdentifier:(NSString *)identifier {
  for (NSToolbarItem *item in _toolbar.items) {
    if ([item.itemIdentifier isEqualToString:identifier]) {
      return item;
    }
    if ([item isKindOfClass:[NSToolbarItemGroup class]]) {
      for (NSToolbarItem *subitem in ((NSToolbarItemGroup *)item).subitems) {
        if ([subitem.itemIdentifier isEqualToString:identifier]) {
          return subitem;
        }
      }
    }
  }
  return nil;
}

/**
 * The leading action item currently on the toolbar, or nil before the toolbar
 * asked for it.
 */
- (NSToolbarItem *)newItem {
  return [self toolbarItemWithIdentifier:VeyraNNewItemIdentifier] ?: _newItem;
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

#pragma mark - Items

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)itemIdentifier
 willBeInsertedIntoToolbar:(BOOL)flag {
  if ([itemIdentifier isEqualToString:VeyraNToggleSidebarIdentifier]) {
    return [self makeToggleSidebarItem];
  }
  if ([itemIdentifier isEqualToString:VeyraNSearchIdentifier]) {
    return [self makeSearchItem];
  }
  if ([itemIdentifier isEqualToString:VeyraNNewItemIdentifier]) {
    return [self makeNewItem];
  }
  // Share, Note Info and More are one group; the identifier is the only one
  // the toolbar is given for them (see -toolbarDefaultItemIdentifiers:).
  if ([itemIdentifier isEqualToString:VeyraNEditorActionsIdentifier]) {
    return [self makeEditorActionsGroup];
  }
  NSUInteger action = VeyraNActionIndex(itemIdentifier);
  if (action != NSNotFound) {
    return [self makeActionItem:action];
  }
  return nil;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:
    (NSToolbar *)toolbar {
  // One band, like Apple Notes. The sidebar toggle is first here and marked
  // navigational (see -makeToggleSidebarItem), so the system places it before
  // the window title, right after the traffic lights; the rest of the band is
  // the list's own menu and the New item, the editor actions - Share, Note
  // Info and More as one glass group - and the search field trail (the flexible
  // space pulls everything after it over), and the field sits at the far right.
  //
  // The columns cannot be tied to the toolbar with separators: Catalyst has no
  // NSTrackingSeparatorToolbarItem. AppKit's header marks it
  // API_UNAVAILABLE(ios) and the Mac Catalyst SDK refuses it ("not available on
  // macCatalyst"), so the items are only ordered, not aligned with the sidebar
  // or list dividers. The order above still reads left (list) to right
  // (editor), which is what it would convey.
  NSMutableArray<NSToolbarItemIdentifier> *identifiers = [NSMutableArray
      arrayWithObjects:VeyraNToggleSidebarIdentifier, VeyraNActionIdentifiers[0],
                       VeyraNNewItemIdentifier,
                       NSToolbarFlexibleSpaceItemIdentifier,
                       VeyraNEditorActionsIdentifier, nil];
  // The field only exists where it can be built; on Mac Catalyst 15 the
  // identifier is left out rather than returned as a nil item (AppKit raises
  // on a missing item).
  if (_searchAvailable) {
    [identifiers addObject:VeyraNSearchIdentifier];
  }
  return identifiers;
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:
    (NSToolbar *)toolbar {
  // Nothing is customizable (allowsUserCustomization is NO); the default set is
  // the whole set.
  return [self toolbarDefaultItemIdentifiers:toolbar];
}

/**
 * One of the icon-only actions (see the arrays at the top): the list's
 * "Sort & View" menu, or one of the editor's Share / Note Info / More, which
 * only ever appear as the subitems of the editor-actions group (see
 * -makeEditorActionsGroup).
 *
 * The label, palette label, tool tip and the image's accessibility description
 * all name the action, because an icon-only item would otherwise be announced
 * and tooltipped with the SF Symbol's own description ("Arrow up, arrow down").
 * The command is kept in the item's `tag` and read back in -actionFromToolbar:
 * (an NSToolbarItem has no other place for it).
 */
- (NSToolbarItem *)makeActionItem:(NSUInteger)index {
  NSToolbarItem *item = [[NSToolbarItem alloc]
      initWithItemIdentifier:VeyraNActionIdentifiers[index]];
  NSString *label = VeyraNActionLabels[index];
  UIImage *image = [UIImage systemImageNamed:VeyraNActionSymbols[index]];
  // A missing symbol would leave a blank item: circle is the oldest SF Symbol
  // and always resolves.
  if (image == nil) {
    image = [UIImage systemImageNamed:@"circle"];
  }
  image.accessibilityLabel = label;
  item.image = image;
  item.label = label;
  item.paletteLabel = label;
  item.toolTip = label;
  // The action this item sends, read back off the sender.
  item.tag = (NSInteger)index;
  item.target = self;
  item.action = @selector(actionFromToolbar:);
  // The leading menu item is the last to be pushed into the overflow menu (with
  // the New item, see -makeNewItem); the editor actions go first, and as
  // subitems they fold away with their group (whose own priority is standard).
  // The search field yields before all of them (see -makeSearchItem), so at
  // 900 pt the window keeps the items that are still useful without the field.
  NSToolbarItemVisibilityPriority priority =
      index == 0 ? NSToolbarItemVisibilityPriorityHigh
                 : NSToolbarItemVisibilityPriorityStandard;
  item.visibilityPriority = priority;
  return item;
}

/**
 * The editor actions as one `NSToolbarItemGroup`: Share, Note Info and More
 * share a single glass capsule in the toolbar, the way Notes, Mail and Finder
 * group related buttons, instead of each surrounded by its own circle.
 *
 * The subitems are built by -makeActionItem: and keep their own identifier,
 * label, tool tip, target/action and `tag`, so -actionFromToolbar: reads the
 * command off the sender unchanged. The convenience
 * `+groupWithItemIdentifier:images:selectionMode:...` constructors are
 * deliberately not used: they build a segmented control with one shared
 * action, which would lose the per-item actions and tool tips.
 */
- (NSToolbarItemGroup *)makeEditorActionsGroup {
  NSToolbarItemGroup *group = [[NSToolbarItemGroup alloc]
      initWithItemIdentifier:VeyraNEditorActionsIdentifier];
  group.subitems = @[
    [self makeActionItem:1], [self makeActionItem:2], [self makeActionItem:3]
  ];
  group.label = @"Note Actions";
  group.paletteLabel = @"Note Actions";
  // The group folds away as a whole with the other editor items.
  group.visibilityPriority = NSToolbarItemVisibilityPriorityStandard;
  return group;
}

- (void)actionFromToolbar:(NSToolbarItem *)item {
  NSInteger index = item.tag;
  if (index < 0 || (NSUInteger)index >= VeyraNActionCount) {
    return;
  }
  [VeyraNMacMenu sendCommand:VeyraNActionCommands[index]];
}

/**
 * The "Toggle Sidebar" button, at the leading edge of the window: it is marked
 * navigational (`NSToolbarItem.navigational`, macOS 11 / Mac Catalyst 14), so
 * the system positions it before the window title, right of the traffic lights,
 * rather than in the item list after the title.
 *
 * It is icon-only, so - like the other action items - the label, palette label
 * and tool tip all have to name the action; otherwise the item would be
 * announced with the SF Symbol's own description ("Sidebar left"). Its command
 * is the one View > Toggle Sidebar (Ctrl-Cmd-S) sends, so the pane collapses
 * through the same handler in hooks/use-mac-menu-commands.ts.
 *
 * It is unbordered: the button sits on the translucent sidebar, and a bordered
 * (bordered is the default) item would draw a filled glass circle behind the
 * glyph, which reads as a heavy disc floating on the sidebar. Native macOS 26
 * apps show it as a plain glyph over the sidebar.
 */
- (NSToolbarItem *)makeToggleSidebarItem {
  NSToolbarItem *item = [[NSToolbarItem alloc]
      initWithItemIdentifier:VeyraNToggleSidebarIdentifier];
  UIImage *image = [UIImage systemImageNamed:VeyraNToggleSidebarSymbol];
  // A missing symbol would leave a blank item: circle is the oldest SF Symbol
  // and always resolves.
  if (image == nil) {
    image = [UIImage systemImageNamed:@"circle"];
  }
  image.accessibilityLabel = VeyraNToggleSidebarLabel;
  item.image = image;
  item.label = VeyraNToggleSidebarLabel;
  item.paletteLabel = VeyraNToggleSidebarLabel;
  item.toolTip = VeyraNToggleSidebarToolTip;
  item.target = self;
  item.action = @selector(toggleSidebarFromToolbar:);
  // No glass chip behind the glyph; the sidebar shows through (see the comment
  // on this item). `bordered` is Mac Catalyst 13+.
  item.bordered = NO;
  if (@available(macCatalyst 14.0, *)) {
    // The system lifts navigational items out of the normal identifier order
    // and places them before the title; without this the item renders in the
    // right-hand group, after the title (where the flexible space sits).
    item.navigational = YES;
  }
  // Navigation chrome is the last thing to fold into the overflow menu.
  item.visibilityPriority = NSToolbarItemVisibilityPriorityHigh;
  return item;
}

- (void)toggleSidebarFromToolbar:(id)sender {
  [VeyraNMacMenu sendCommand:VeyraNToggleSidebarCommand];
}

/**
 * The search field, at the trailing side of the toolbar and after the editor
 * actions, the way Finder, Mail and Notes carry theirs.
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
 *
 * The view the item hosts is a glass capsule wrapping the field, so the search
 * box matches the bordered items beside it instead of standing out as a flat
 * grey rectangle (see -makeSearchContainerWithField:).
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
    // The item hosts the capsule around the field, not the field itself: the
    // field stays transparent inside it (see makeSearchContainerWithField:).
    NSUIViewToolbarItem *item = [[NSUIViewToolbarItem alloc]
        initWithItemIdentifier:VeyraNSearchIdentifier
                        uiView:[self makeSearchContainerWithField:field]];
    item.label = @"Search";
    item.paletteLabel = @"Search";
    item.toolTip = @"Search";
    // The field is the widest item and the one the app can live without
    // longest: it is pushed into the overflow menu before the buttons.
    item.visibilityPriority = NSToolbarItemVisibilityPriorityLow;
    return item;
  }
  return nil;
}

/**
 * The field itself: a standard `UISearchTextField` (magnifier, clear button)
 * with its text carried over and wired to the toolbar for edits and Return. It
 * is left transparent and borderless, because it lives inside the glass capsule
 * the container draws (see -makeSearchContainerWithField:); UIKit exposes no
 * background image to clear on `UISearchTextField`, so the fill it would
 * normally draw is removed with `borderStyle` and a clear `backgroundColor`.
 * It is sized entirely by the container's constraints.
 */
- (UISearchTextField *)makeSearchField {
  UISearchTextField *field =
      [[UISearchTextField alloc] initWithFrame:CGRectZero];
  field.translatesAutoresizingMaskIntoConstraints = NO;
  field.placeholder = @"Search";
  field.returnKeyType = UIReturnKeySearch;
  field.clearButtonMode = UITextFieldViewModeWhileEditing;
  // No border and no fill: the capsule supplies both, so the field does not
  // paint a second grey rectangle inside it.
  field.borderStyle = UITextBorderStyleNone;
  field.backgroundColor = UIColor.clearColor;
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
  return field;
}

/**
 * Wraps the field in a glass capsule that matches the bordered items beside
 * it: a `UISearchTextField` on its own is a flat grey rounded rectangle, which
 * next to the toolbar's glass capsules reads as a different, older control.
 *
 * On macOS 26 the capsule is real Liquid Glass (`UIGlassEffect`, style
 * regular); older systems get the nearest material, the thin translucent blur
 * (glass does not exist there). The effect view is the capsule: clipped, and
 * either given the scaling capsule corner configuration (26+) or the
 * half-height continuous radius, so the field inside cannot paint outside it.
 *
 * The container is what the toolbar item hosts and measures, so the size
 * constraints live here rather than on the field; the effect view's
 * contentView pins the field with a small inset at the ends.
 */
- (UIView *)makeSearchContainerWithField:(UISearchTextField *)field {
  UIVisualEffect *effect = nil;
  if (@available(ios 26.0, macCatalyst 26.0, *)) {
    effect = [UIGlassEffect effectWithStyle:UIGlassEffectStyleRegular];
  } else {
    effect = [UIBlurEffect effectWithStyle:UIBlurEffectStyleSystemThinMaterial];
  }
  UIVisualEffectView *effectView =
      [[UIVisualEffectView alloc] initWithEffect:effect];
  effectView.translatesAutoresizingMaskIntoConstraints = NO;
  // The material is clipped to the capsule shape.
  effectView.clipsToBounds = YES;
  if (@available(ios 26.0, macCatalyst 26.0, *)) {
    // The glass shape scales with the view; macOS 26 rounds it into a capsule.
    effectView.cornerConfiguration =
        [UICornerConfiguration capsuleConfiguration];
  } else {
    effectView.layer.cornerRadius = VeyraNSearchFieldHeight / 2;
    effectView.layer.cornerCurve = kCACornerCurveContinuous;
  }

  UIView *container = [[UIView alloc]
      initWithFrame:CGRectMake(0, 0, VeyraNSearchFieldWidth,
                               VeyraNSearchFieldHeight)];
  [container addSubview:effectView];
  UIView *content = effectView.contentView;
  [content addSubview:field];

  [NSLayoutConstraint activateConstraints:@[
    // The capsule fills the container the item measures.
    [effectView.leadingAnchor constraintEqualToAnchor:container.leadingAnchor],
    [effectView.trailingAnchor
        constraintEqualToAnchor:container.trailingAnchor],
    [effectView.topAnchor constraintEqualToAnchor:container.topAnchor],
    [effectView.bottomAnchor constraintEqualToAnchor:container.bottomAnchor],
    // The field keeps a small inset at the ends and fills the height, so the
    // magnifier and clear button stay inside the rounded shape.
    [field.leadingAnchor constraintEqualToAnchor:content.leadingAnchor
                                        constant:6],
    [field.trailingAnchor constraintEqualToAnchor:content.trailingAnchor
                                         constant:-6],
    [field.topAnchor constraintEqualToAnchor:content.topAnchor],
    [field.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
  ]];

  // The toolbar measures the view it is handed, so the old field size
  // constraints moved here. The width yields to the item's own compression
  // before the field would be clipped; the height keeps the capsule from being
  // stretched to the toolbar's full height.
  NSLayoutConstraint *width =
      [container.widthAnchor constraintEqualToConstant:VeyraNSearchFieldWidth];
  width.priority = UILayoutPriorityDefaultHigh;
  NSLayoutConstraint *height = [container.heightAnchor
      constraintEqualToConstant:VeyraNSearchFieldHeight];
  [NSLayoutConstraint activateConstraints:@[ width, height ]];
  return container;
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
  // The most important item in the band: it is the last one to be dropped into
  // the overflow menu.
  item.visibilityPriority = NSToolbarItemVisibilityPriorityHigh;
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

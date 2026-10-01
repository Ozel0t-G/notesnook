#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import "RNShortcuts.h"
#import "RNBootSplash.h"
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import "RNFileUploader.h"
#if TARGET_OS_MACCATALYST
#import "MacMenu/VeyraNMacMenu.h"
// File > Print prints the editor's WKWebView through its own print formatter
// (see -veyranPrint:).
#import <WebKit/WebKit.h>
#endif

@interface ReactNativeDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@implementation ReactNativeDelegate

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end

@interface AppDelegate ()
@property (nonatomic, strong) ReactNativeDelegate *reactNativeDelegate;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.dependencyProvider = [RCTAppDependencyProvider new];
  ReactNativeDelegate *delegate = [ReactNativeDelegate new];
  RCTReactNativeFactory *factory = [[RCTReactNativeFactory alloc] initWithDelegate:delegate];
  delegate.dependencyProvider = [RCTAppDependencyProvider new];
  self.reactNativeDelegate = delegate;
  
  self.reactNativeFactory = factory;
  // The window is created and React Native is started by SceneDelegate
  // (UIScene lifecycle is mandatory with the iOS 27 SDK).
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)connectingSceneSession
                                   options:(UISceneConnectionOptions *)options
{
  UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Default Configuration"
                                                                        sessionRole:connectingSceneSession.role];
  configuration.delegateClass = NSClassFromString(@"SceneDelegate");
  return configuration;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}
 
- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

- (void)application:(UIApplication *)application performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL))completionHandler {
  [RNShortcuts performActionForShortcutItem:shortcutItem completionHandler:completionHandler];
}

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (void)customizeRootView:(RCTRootView *)rootView {
  [RNBootSplash initWithStoryboard:@"BootSplash" rootView:rootView]; // ⬅️ initialize the splash screen
}

- (void)application:(UIApplication *)application handleEventsForBackgroundURLSession:(NSString *)identifier completionHandler:(void (^)())completionHandler {
  [RNFileUploader setCompletionHandlerWithIdentifier:identifier completionHandler:completionHandler];
}

#if TARGET_OS_MACCATALYST
#pragma mark - Mac Catalyst menu bar

/// True when a UIKit text input owns the keyboard focus. The Notes editor is a
/// WKWebView, which is *not* a UITextField/UITextView, so Escape keeps working
/// there while a real UIKit text field keeps its own Escape handling.
static BOOL VeyraNIsTextInputFirstResponder(UIView *view) {
  if (([view isKindOfClass:[UITextField class]] ||
       [view isKindOfClass:[UITextView class]]) &&
      view.isFirstResponder) {
    return YES;
  }
  for (UIView *subview in view.subviews) {
    if (VeyraNIsTextInputFirstResponder(subview)) {
      return YES;
    }
  }
  return NO;
}

- (BOOL)veyran_isTextInputFirstResponder {
  if (self.window && VeyraNIsTextInputFirstResponder(self.window)) {
    return YES;
  }
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (VeyraNIsTextInputFirstResponder(window)) {
        return YES;
      }
    }
  }
  return NO;
}

/**
 * The identifier of the app's own "Note" menu (see -buildMenuWithBuilder:).
 * Namespaced like the toolbar's identifiers.
 */
static UIMenuIdentifier const VeyraNNoteMenuIdentifier = @"veyran.note";

- (void)veyranNewNote:(id)sender {
  [VeyraNMacMenu sendCommand:@"newNote"];
}

- (void)veyranFindInNotes:(id)sender {
  [VeyraNMacMenu sendCommand:@"findInNotes"];
}

- (void)veyranSelectLibrary:(id)sender {
  [VeyraNMacMenu sendCommand:@"section:library"];
}

- (void)veyranSelectTasks:(id)sender {
  [VeyraNMacMenu sendCommand:@"section:tasks"];
}

- (void)veyranSelectSearch:(id)sender {
  [VeyraNMacMenu sendCommand:@"section:search"];
}

- (void)veyranMoveToTrash:(id)sender {
  [VeyraNMacMenu sendCommand:@"moveToTrash"];
}

- (void)veyranOpenSettings:(id)sender {
  [VeyraNMacMenu sendCommand:@"openSettings"];
}

- (void)veyranToggleSidebar:(id)sender {
  [VeyraNMacMenu sendCommand:@"toggleSidebar"];
}

- (void)veyranNewNotebook:(id)sender {
  [VeyraNMacMenu sendCommand:@"newNotebook"];
}

- (void)veyranImport:(id)sender {
  [VeyraNMacMenu sendCommand:@"import"];
}

- (void)veyranExport:(id)sender {
  [VeyraNMacMenu sendCommand:@"exportNote"];
}

- (void)veyranPinNote:(id)sender {
  [VeyraNMacMenu sendCommand:@"pinNote"];
}

- (void)veyranOpenHelp:(id)sender {
  [VeyraNMacMenu sendCommand:@"openHelp"];
}

/**
 * The first visible WKWebView below `view`, which on the editor screen is the
 * note's editor WebView (the app has no other visible one; sheets that carry a
 * WebView are presented over the window, not inside it). Answers nil when there
 * is none.
 */
static WKWebView *VeyraNFirstVisibleWebView(UIView *view) {
  if (view.isHidden || view.alpha <= 0.01) {
    return nil;
  }
  if ([view isKindOfClass:[WKWebView class]]) {
    return (WKWebView *)view;
  }
  for (UIView *subview in view.subviews) {
    WKWebView *found = VeyraNFirstVisibleWebView(subview);
    if (found != nil) {
      return found;
    }
  }
  return nil;
}

/**
 * File > Print (Cmd-P, E5). The note is rendered in a WKWebView, which carries
 * no `window.print()` handler, so the native print path is used: the web
 * view's own print formatter (`-viewPrintFormatter`, WKWebView paginates the
 * loaded page for it) is handed to a UIPrintInteractionController, which shows
 * the standard print panel as a sheet. The sandbox entitlement
 * `com.apple.security.print` is required for this (Notesnook-macOS.entitlements).
 *
 * The menu item is disabled without an open note (see -validateCommand:), so
 * reaching this without one is only possible if the note closed in between; the
 * method then does nothing.
 */
- (void)veyranPrint:(id)sender {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
      if (candidate.isKeyWindow) {
        window = candidate;
        break;
      }
    }
    if (window != nil) {
      break;
    }
  }
  if (window == nil) {
    window = self.window;
  }
  WKWebView *webView = window ? VeyraNFirstVisibleWebView(window) : nil;
  if (webView == nil || ![UIPrintInteractionController isPrintingAvailable]) {
    return;
  }
  UIPrintInteractionController *controller =
      [UIPrintInteractionController sharedPrintController];
  if (controller == nil) {
    return;
  }
  UIPrintInfo *printInfo = [UIPrintInfo printInfo];
  printInfo.outputType = UIPrintInfoOutputGeneral;
  printInfo.jobName = webView.title.length > 0 ? webView.title : @"Note";
  controller.printInfo = printInfo;
  controller.printFormatter = [webView viewPrintFormatter];
  [controller presentAnimated:YES completionHandler:nil];
}

- (void)veyranEscape:(id)sender {
  // Never steal Escape from a real UIKit text field.
  if ([self veyran_isTextInputFirstResponder]) {
    return;
  }
  [VeyraNMacMenu sendCommand:@"escape"];
}

/**
 * Escape closes the topmost sheet/modal. This is a key command on the app
 * delegate - the last responder in the chain - rather than a menu item:
 * Catalyst lists a UIKeyCommand even when it is marked
 * UIMenuElementAttributesHidden, which left a "Close Sheet" item in the View
 * menu, and a menu is the only place the command can hide from the menu bar.
 * The text-input guard lives in -veyranEscape:.
 */
- (NSArray<UIKeyCommand *> *)keyCommands {
  UIKeyCommand *escape =
      [UIKeyCommand keyCommandWithInput:UIKeyInputEscape
                          modifierFlags:0
                                 action:@selector(veyranEscape:)];
  if (@available(iOS 15.0, *)) {
    escape.wantsPriorityOverSystemBehavior = YES;
  }
  return @[ escape ];
}

/**
 * Builds one titled menu command: `input` is the key equivalent that runs it
 * (the empty string for an item that has none) and `action` is the AppDelegate
 * selector that forwards the command to JavaScript.
 */
static UIKeyCommand *VeyraNMenuCommand(NSString *title, NSString *input,
                                       UIKeyModifierFlags modifiers,
                                       SEL action) {
  return [UIKeyCommand commandWithTitle:title
                                  image:nil
                                 action:action
                                  input:input
                          modifierFlags:modifiers
                           propertyList:nil];
}

/**
 * Builds one block-based menu action that forwards `command` to JavaScript,
 * greyed out when `enabled` is NO. Block-based actions carry no selector, so
 * their disabled attribute survives menu validation and stays in effect until
 * the next rebuild (see -setContext:); commands that need a key equivalent use
 * VeyraNMenuCommand and are validated in -validateCommand: instead.
 */
static UIAction *VeyraNMenuAction(NSString *title, NSString *command,
                                  BOOL enabled) {
  UIAction *action =
      [UIAction actionWithTitle:title
                          image:nil
                     identifier:nil
                        handler:^(__kindof UIAction *_Nonnull action) {
                          [VeyraNMacMenu sendCommand:command];
                        }];
  if (!enabled) {
    action.attributes = UIMenuElementAttributesDisabled;
  }
  return action;
}

/**
 * Rebuilds the Catalyst main menu:
 *  - removes the document commands that UISupportsDocumentBrowser /
 *    LSSupportsOpeningDocumentsInPlace add (Open..., Open Recent, Duplicate,
 *    Rename..., Move..., Export As...) since the app is a note library, not a
 *    document browser;
 *  - adds File > New Note (Cmd-N), New Notebook (Shift-Cmd-N), Import...,
 *    Export... and Print... (Cmd-P);
 *  - adds Edit > Find in Notes (Cmd-Shift-F), which switches the app to its
 *    Search section;
 *  - adds a "Note" menu (UIMenuEdit's sibling, right after Edit) with the
 *    actions on the note open in the editor: Pin Note (Shift-Cmd-P), Add to
 *    Favorites, Lock Note and Move to Trash (Cmd-Delete);
 *  - adds View > Library / Tasks / Search (Cmd-1/2/3), the same three
 *    sections as the window toolbar's segmented control, View > Sort By /
 *    Group By (forwarded to the focused list's own menu) and View > Toggle
 *    Sidebar (Ctrl-Cmd-S);
 *  - removes Catalyst's own View > Show Sidebar (UIMenuSidebar), which drives
 *    a UISplitViewController the app does not have and therefore did nothing;
 *  - replaces the Help menu with one "VeyraN Help" item that opens the project
 *    documentation in the browser (there is no Help Book, K5/I11);
 *  - adds application menu > Settings... (Cmd-,) right after About.
 *
 * Commands without a target are greyed out (K4): the build state comes from
 * VeyraNMacMenu's menu context, which JS publishes through `setContext` from
 * app/hooks/use-mac-menu-commands.ts; block-based actions keep the disabled
 * attribute set here, key commands are also re-checked in -validateCommand:.
 * A change of the context triggers a rebuild (see -[VeyraNMacMenu setContext:]).
 *
 * Escape is not a menu item at all (see -keyCommands): a hidden UIKeyCommand is
 * still listed by Catalyst, so it is handled as a key command on this delegate.
 *
 * Everything but the document-command removals ends up in JavaScript, which
 * owns the app state.
 */
- (void)buildMenuWithBuilder:(id<UIMenuBuilder>)builder {
  [super buildMenuWithBuilder:builder];
  if (builder.system != UIMenuSystem.mainSystem) {
    return;
  }

  // The context JS last published; NO until it has spoken, so the commands
  // that need a note or list start out greyed (K4).
  BOOL hasNote = [VeyraNMacMenu menuContextHasNote];
  BOOL hasList = [VeyraNMacMenu menuContextHasList];

  // "Open..." lives in its own UIMenuOpen submenu on Catalyst.
  if ([builder menuForIdentifier:UIMenuOpen]) {
    [builder removeMenuForIdentifier:UIMenuOpen];
  }
  if ([builder menuForIdentifier:UIMenuOpenRecent]) {
    [builder removeMenuForIdentifier:UIMenuOpenRecent];
  }
  // UIMenuDocument (iOS 16+) owns the remaining document commands
  // (Duplicate / Rename / Move / Export As).
  if (@available(iOS 16.0, *)) {
    if ([builder menuForIdentifier:UIMenuDocument]) {
      [builder removeMenuForIdentifier:UIMenuDocument];
    }
  }
  // W3: the app has no multi-window support, so the system's New Window group
  // (UIMenuNewItem, the non-deprecated name of UIMenuNewScene) has no target
  // and is removed. Runtime showed no "New Window" item at all, but the removal
  // keeps a new SDK from reintroducing a dead entry.
  if (@available(iOS 26.0, *)) {
    if ([builder menuForIdentifier:UIMenuNewItem]) {
      [builder removeMenuForIdentifier:UIMenuNewItem];
    }
  }

  // File: New Note (Cmd-N) / New Notebook (Shift-Cmd-N) first, then the
  // transfer group Import... / Export... / Print... (Cmd-P), both before the
  // system's Close items. Export and Print need a note (K4/E5/E6).
  if ([builder menuForIdentifier:UIMenuFile]) {
    UIKeyCommand *newNote =
        [UIKeyCommand keyCommandWithInput:@"n"
                            modifierFlags:UIKeyModifierCommand
                                   action:@selector(veyranNewNote:)];
    newNote.title = @"New Note";
    UIKeyCommand *newNotebook =
        VeyraNMenuCommand(@"New Notebook", @"n",
                          UIKeyModifierCommand | UIKeyModifierShift,
                          @selector(veyranNewNotebook:));
    UIMenu *newMenu = [UIMenu menuWithTitle:@""
                                      image:nil
                                 identifier:nil
                                    options:UIMenuOptionsDisplayInline
                                   children:@[ newNote, newNotebook ]];

    UIAction *importNotes = VeyraNMenuAction(@"Import…", @"import", YES);
    UIAction *exportNote = VeyraNMenuAction(@"Export…", @"exportNote", hasNote);
    UIKeyCommand *printNote =
        VeyraNMenuCommand(@"Print…", @"p", UIKeyModifierCommand,
                          @selector(veyranPrint:));
    printNote.attributes =
        hasNote ? 0 : UIMenuElementAttributesDisabled;
    UIMenu *transferMenu = [UIMenu menuWithTitle:@""
                                           image:nil
                                      identifier:nil
                                         options:UIMenuOptionsDisplayInline
                                        children:@[
                                          importNotes, exportNote, printNote
                                        ]];

    // Inserted in reverse (the second insert lands before the first), so the
    // final order is New group, transfer group, then the system's File items.
    [builder insertChildMenu:transferMenu atStartOfMenuForIdentifier:UIMenuFile];
    [builder insertChildMenu:newMenu atStartOfMenuForIdentifier:UIMenuFile];
  }

  // Edit > Find in Notes (Cmd-Shift-F): the app's Search section, the Mac
  // counterpart of "Find in Note".
  if ([builder menuForIdentifier:UIMenuEdit]) {
    UIKeyCommand *findInNotes =
        VeyraNMenuCommand(@"Find in Notes", @"f",
                          UIKeyModifierCommand | UIKeyModifierShift,
                          @selector(veyranFindInNotes:));
    UIMenu *findInNotesMenu = [UIMenu menuWithTitle:@""
                                              image:nil
                                         identifier:nil
                                            options:UIMenuOptionsDisplayInline
                                           children:@[ findInNotes ]];
    [builder insertChildMenu:findInNotesMenu
       atEndOfMenuForIdentifier:UIMenuEdit];
  }

  // The "Note" menu, right after Edit: the actions on the note open in the
  // editor. Pin is Shift-Cmd-P and Move to Trash is Cmd-Delete, like in Notes;
  // Favorite (no free shortcut: Shift-Cmd-F is Edit > Find in Notes) and Lock
  // Note are block-based actions. Everything is greyed out without an open note
  // (K4).
  UIKeyCommand *pinNote =
      VeyraNMenuCommand(@"Pin Note", @"p",
                        UIKeyModifierCommand | UIKeyModifierShift,
                        @selector(veyranPinNote:));
  pinNote.attributes = hasNote ? 0 : UIMenuElementAttributesDisabled;
  UIAction *toggleFavorite =
      VeyraNMenuAction(@"Add to Favorites", @"toggleFavorite", hasNote);
  UIAction *lockNote = VeyraNMenuAction(@"Lock Note", @"lockNote", hasNote);
  UIKeyCommand *moveToTrash =
      VeyraNMenuCommand(@"Move to Trash", UIKeyInputDelete,
                        UIKeyModifierCommand, @selector(veyranMoveToTrash:));
  moveToTrash.attributes = hasNote ? 0 : UIMenuElementAttributesDisabled;
  UIMenu *noteMenu = [UIMenu menuWithTitle:@"Note"
                                     image:nil
                                identifier:VeyraNNoteMenuIdentifier
                                   options:0
                                  children:@[
                                    pinNote, toggleFavorite, lockNote,
                                    moveToTrash
                                  ]];
  if ([builder menuForIdentifier:UIMenuEdit]) {
    [builder insertSiblingMenu:noteMenu afterMenuForIdentifier:UIMenuEdit];
  }

  // View > Library / Tasks / Search (Cmd-1/2/3): the sections the window
  // toolbar's segmented control switches between.
  UIKeyCommand *librarySection =
      VeyraNMenuCommand(@"Library", @"1", UIKeyModifierCommand,
                        @selector(veyranSelectLibrary:));
  UIKeyCommand *tasksSection =
      VeyraNMenuCommand(@"Tasks", @"2", UIKeyModifierCommand,
                        @selector(veyranSelectTasks:));
  UIKeyCommand *searchSection =
      VeyraNMenuCommand(@"Search", @"3", UIKeyModifierCommand,
                        @selector(veyranSelectSearch:));
  UIMenu *sectionsMenu = [UIMenu menuWithTitle:@""
                                         image:nil
                                    identifier:nil
                                       options:UIMenuOptionsDisplayInline
                                      children:@[
                                        librarySection, tasksSection,
                                        searchSection
                                      ]];

  // View > Sort By / Group By: the commands the focused list's own "…" menu
  // runs (components/list-view-menu.ts, published into useMacWindowStore by the
  // list header). The command ids are that menu's own ids, so JS only has to
  // forward them; they are greyed out while no list is on screen (K4/R19).
  UIAction *sortByEdited =
      VeyraNMenuAction(@"Date edited", @"sort:dateEdited", hasList);
  UIAction *sortByCreated =
      VeyraNMenuAction(@"Date created", @"sort:dateCreated", hasList);
  UIAction *sortByTitle =
      VeyraNMenuAction(@"Title", @"sort:title", hasList);
  UIMenu *sortByMenu = [UIMenu menuWithTitle:@"Sort By"
                                       image:nil
                                  identifier:nil
                                     options:0
                                    children:@[
                                      sortByEdited, sortByCreated, sortByTitle
                                    ]];
  UIAction *groupByDefault =
      VeyraNMenuAction(@"Default", @"group:default", hasList);
  UIAction *groupByNone =
      VeyraNMenuAction(@"None", @"group:none", hasList);
  UIAction *groupByAbc = VeyraNMenuAction(@"Abc", @"group:abc", hasList);
  UIAction *groupByYear = VeyraNMenuAction(@"Year", @"group:year", hasList);
  UIAction *groupByWeek = VeyraNMenuAction(@"Week", @"group:week", hasList);
  UIAction *groupByMonth = VeyraNMenuAction(@"Month", @"group:month", hasList);
  UIMenu *groupByMenu = [UIMenu menuWithTitle:@"Group By"
                                        image:nil
                                   identifier:nil
                                      options:0
                                     children:@[
                                       groupByDefault, groupByNone, groupByAbc,
                                       groupByYear, groupByWeek, groupByMonth
                                     ]];
  UIMenu *sortAndGroupMenu =
      [UIMenu menuWithTitle:@""
                      image:nil
                 identifier:nil
                    options:UIMenuOptionsDisplayInline
                   children:@[ sortByMenu, groupByMenu ]];

  if ([builder menuForIdentifier:UIMenuView]) {
    // Inserted back to front: Sort & Group sits after the section commands,
    // which sit first; the system's View items follow and Toggle Sidebar is
    // appended at the end further down.
    [builder insertChildMenu:sortAndGroupMenu
     atStartOfMenuForIdentifier:UIMenuView];
    [builder insertChildMenu:sectionsMenu
     atStartOfMenuForIdentifier:UIMenuView];
  }

  // Application menu > Settings..., right after About.
  UIKeyCommand *settings = [UIKeyCommand keyCommandWithInput:@","
                                               modifierFlags:UIKeyModifierCommand
                                                      action:@selector(veyranOpenSettings:)];
  settings.title = @"Settings…";
  UIMenu *settingsMenu = [UIMenu menuWithTitle:@""
                                          image:nil
                                     identifier:nil
                                        options:UIMenuOptionsDisplayInline
                                       children:@[ settings ]];
  if ([builder menuForIdentifier:UIMenuAbout]) {
    [builder insertSiblingMenu:settingsMenu afterMenuForIdentifier:UIMenuAbout];
  } else if ([builder menuForIdentifier:UIMenuPreferences]) {
    [builder replaceMenuForIdentifier:UIMenuPreferences withMenu:settingsMenu];
  }

  // Catalyst ships its own View > Show Sidebar item, which drives a
  // UISplitViewController. This app has none, so the item did nothing: remove
  // it and put the app's own Toggle Sidebar (Ctrl-Cmd-S) in its place.
  if (@available(iOS 15.0, *)) {
    if ([builder menuForIdentifier:UIMenuSidebar]) {
      [builder removeMenuForIdentifier:UIMenuSidebar];
    }
  }
  if ([builder menuForIdentifier:UIMenuView]) {
    UIKeyCommand *toggleSidebar =
        VeyraNMenuCommand(@"Toggle Sidebar", @"s",
                          UIKeyModifierControl | UIKeyModifierCommand,
                          @selector(veyranToggleSidebar:));
    UIMenu *toggleSidebarMenu =
        [UIMenu menuWithTitle:@""
                        image:nil
                   identifier:nil
                      options:UIMenuOptionsDisplayInline
                     children:@[ toggleSidebar ]];
    [builder insertChildMenu:toggleSidebarMenu
       atEndOfMenuForIdentifier:UIMenuView];
  }
}

/**
 * Keeps the note commands that carry a key equivalent disabled while no note is
 * open (K4). The disabled attribute is already set when the menu is built (see
 * -buildMenuWithBuilder:), but UIKit validates UIKeyCommands against the
 * responder chain before showing the menu and would re-enable a command whose
 * selector this delegate implements; block-based UIActions carry no selector
 * and are not validated, so only the four key commands are handled here.
 */
- (void)validateCommand:(UICommand *)command {
  [super validateCommand:command];
  if ([VeyraNMacMenu menuContextHasNote]) {
    return;
  }
  SEL action = command.action;
  if (action == @selector(veyranPinNote:) ||
      action == @selector(veyranMoveToTrash:) ||
      action == @selector(veyranExport:) ||
      action == @selector(veyranPrint:)) {
    command.attributes |= UIMenuElementAttributesDisabled;
  }
}
#endif

@end

#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import "RNShortcuts.h"
#import "RNBootSplash.h"
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import "RNFileUploader.h"
#if TARGET_OS_MACCATALYST
#import "MacMenu/VeyraNMacMenu.h"
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

- (void)veyranEscape:(id)sender {
  // Never steal Escape from a real UIKit text field.
  if ([self veyran_isTextInputFirstResponder]) {
    return;
  }
  [VeyraNMacMenu sendCommand:@"escape"];
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
 * Rebuilds the Catalyst main menu:
 *  - removes the document commands that UISupportsDocumentBrowser /
 *    LSSupportsOpeningDocumentsInPlace add (Open..., Open Recent, Duplicate,
 *    Rename..., Move..., Export As...) since the app is a note library, not a
 *    document browser;
 *  - adds File > New Note (Cmd-N);
 *  - adds Edit > Find in Notes (Cmd-Shift-F), which switches the app to its
 *    Search section;
 *  - adds a "Note" menu (UIMenuEdit's sibling, right after Edit) with the
 *    actions on the note open in the editor: Pin Note, Add to Favorites and
 *    Move to Trash (Cmd-Delete). They stay enabled - JavaScript finds nothing
 *    to act on when no note is open and ignores them (see
 *    app/hooks/use-mac-menu-commands.ts);
 *  - adds View > Library / Tasks / Search (Cmd-1/2/3), the same three
 *    sections as the window toolbar's segmented control;
 *  - adds application menu > Settings... (Cmd-,) right after About;
 *  - adds a hidden Escape command that closes the topmost sheet/modal.
 *
 * Everything but the document-command removals ends up in JavaScript, which
 * owns the app state.
 */
- (void)buildMenuWithBuilder:(id<UIMenuBuilder>)builder {
  [super buildMenuWithBuilder:builder];
  if (builder.system != UIMenuSystem.mainSystem) {
    return;
  }

  // "Open..." lives in its own UIMenuOpen submenu on Catalyst.
  if ([builder menuForIdentifier:UIMenuOpen]) {
    [builder removeMenuForIdentifier:UIMenuOpen];
  }
  if ([builder menuForIdentifier:UIMenuOpenRecent]) {
    [builder removeMenuForIdentifier:UIMenuOpenRecent];
  }
  // UIMenuDocument (iOS 16+) owns the remaining document commands
  // (Duplicate / Rename / Move / Export As). Note that we deliberately do NOT
  // remove UIMenuNewScene: on the iOS 26 SDK that identifier is the deprecated
  // name of UIMenuNewItem ("New Window"/New Scene group), not the Open command.
  if (@available(iOS 16.0, *)) {
    if ([builder menuForIdentifier:UIMenuDocument]) {
      [builder removeMenuForIdentifier:UIMenuDocument];
    }
  }

  if ([builder menuForIdentifier:UIMenuFile]) {
    UIKeyCommand *newNote = [UIKeyCommand keyCommandWithInput:@"n"
                                                modifierFlags:UIKeyModifierCommand
                                                       action:@selector(veyranNewNote:)];
    newNote.title = @"New Note";
    UIMenu *newNoteMenu = [UIMenu menuWithTitle:@""
                                          image:nil
                                     identifier:nil
                                        options:UIMenuOptionsDisplayInline
                                       children:@[ newNote ]];
    [builder insertChildMenu:newNoteMenu atStartOfMenuForIdentifier:UIMenuFile];
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
  // editor. Pin/Favorite are UIActions because they have no key equivalent of
  // their own; Move to Trash is Cmd-Delete, like in Notes.
  UIAction *pinNote =
      [UIAction actionWithTitle:@"Pin Note"
                          image:nil
                     identifier:nil
                        handler:^(__kindof UIAction *_Nonnull action) {
                          [VeyraNMacMenu sendCommand:@"pinNote"];
                        }];
  UIAction *toggleFavorite =
      [UIAction actionWithTitle:@"Add to Favorites"
                          image:nil
                     identifier:nil
                        handler:^(__kindof UIAction *_Nonnull action) {
                          [VeyraNMacMenu sendCommand:@"toggleFavorite"];
                        }];
  UIKeyCommand *moveToTrash =
      VeyraNMenuCommand(@"Move to Trash", UIKeyInputDelete,
                        UIKeyModifierCommand, @selector(veyranMoveToTrash:));
  UIMenu *noteMenu = [UIMenu menuWithTitle:@"Note"
                                     image:nil
                                identifier:VeyraNNoteMenuIdentifier
                                   options:0
                                  children:@[
                                    pinNote, toggleFavorite, moveToTrash
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
  if ([builder menuForIdentifier:UIMenuView]) {
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

  // Hidden Escape key command, flattened into the View menu. Not listed in the
  // menu bar but still routed to -veyranEscape:.
  UIKeyCommand *escape = [UIKeyCommand keyCommandWithInput:UIKeyInputEscape
                                             modifierFlags:0
                                                    action:@selector(veyranEscape:)];
  escape.attributes = UIMenuElementAttributesHidden;
  if (@available(iOS 15.0, *)) {
    escape.wantsPriorityOverSystemBehavior = YES;
  }
  if ([builder menuForIdentifier:UIMenuView]) {
    UIMenu *closeSheetMenu = [UIMenu menuWithTitle:@"Close Sheet"
                                             image:nil
                                        identifier:nil
                                           options:UIMenuOptionsDisplayInline
                                          children:@[ escape ]];
    [builder insertChildMenu:closeSheetMenu atEndOfMenuForIdentifier:UIMenuView];
  }
}
#endif

@end

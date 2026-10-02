#import "SceneDelegate.h"
#import "AppDelegate.h"
#import <React/RCTLinkingManager.h>
#import "RNShortcuts.h"

#if TARGET_OS_MACCATALYST
#import "MacMenu/VeyraNMacMenu.h"
#import "MacMenu/VeyraNMacToolbar.h"

@interface SceneDelegate ()

/// The window's native toolbar. NSToolbar holds its delegate weakly, so the
/// object itself has to stay alive for as long as the window shows it.
@property (nonatomic, strong) VeyraNMacToolbar *macToolbar;

@end
#endif

#if TARGET_OS_MACCATALYST
/// Key of the last window frame (NSStringFromCGRect), kept in NSUserDefaults so
/// the window comes back with the size and position the user left it at (W1).
static NSString *const VeyraNMacWindowFrameKey = @"VeyraNMacWindowFrame";
static const CGSize VeyraNMacMinimumWindowSize = {900, 600};
static const CGSize VeyraNMacDefaultWindowSize = {1200, 800};

/// A saved frame is only used when it is at least the minimum size and still
/// overlaps a screen (a disconnected display must not park the window off-screen).
static BOOL VeyraNMacFrameIsUsable(CGRect frame) {
  if (frame.size.width < VeyraNMacMinimumWindowSize.width ||
      frame.size.height < VeyraNMacMinimumWindowSize.height) {
    return NO;
  }
  return YES;
}

/// Asks the system for the saved frame (or the default size on first launch).
static void VeyraNMacRestoreWindowFrame(UIWindowScene *windowScene) {
  if (@available(macCatalyst 16.0, *)) {
    NSString *saved = [[NSUserDefaults standardUserDefaults] stringForKey:VeyraNMacWindowFrameKey];
    CGRect frame = saved != nil ? CGRectFromString(saved) : CGRectZero;
    NSLog(@"VeyraN: window frame restore saved=%@", saved ?: @"none");
    UIWindowSceneGeometryPreferencesMac *preferences = nil;
    if (VeyraNMacFrameIsUsable(frame)) {
      preferences = [[UIWindowSceneGeometryPreferencesMac alloc] initWithSystemFrame:frame];
    } else {
      CGRect current = windowScene.effectiveGeometry.systemFrame;
      CGRect initial = CGRectMake(current.origin.x, current.origin.y,
                                  VeyraNMacDefaultWindowSize.width,
                                  VeyraNMacDefaultWindowSize.height);
      preferences = [[UIWindowSceneGeometryPreferencesMac alloc] initWithSystemFrame:initial];
    }
    [windowScene requestGeometryUpdateWithPreferences:preferences
                                         errorHandler:^(NSError *_Nonnull error) {
                                           NSLog(@"VeyraN: window frame restore failed: %@", error);
                                         }];
  }
}

/// The Mac window's own background colour, following the app's appearance.
///
/// Catalyst never shows the desktop through a clear `UIWindow`: a clear window
/// just makes the app's glass panels sample a blank (light) backdrop, which is
/// what turned the sidebar's Liquid Glass into a flat light slab. The window is
/// opaque instead, and the strip between the floating glass panel and the
/// window edge is this colour. Dark uses systemBackgroundColor, light
/// systemGroupedBackgroundColor; both are dynamic colours, so they resolve
/// against the window's `overrideUserInterfaceStyle` - the *app* theme, pushed
/// by JS through VeyraNMacMenu (see -scene:willConnectToSession:options:).
static UIColor *VeyraNMacWindowBackgroundColor(void) {
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
    if (traits.userInterfaceStyle == UIUserInterfaceStyleDark) {
      return [[UIColor systemBackgroundColor] resolvedColorWithTraitCollection:traits];
    }
    return [[UIColor systemGroupedBackgroundColor] resolvedColorWithTraitCollection:traits];
  }];
}

/// Remembers the window's current frame.
static void VeyraNMacSaveWindowFrame(UIWindowScene *windowScene) {
  if (@available(macCatalyst 16.0, *)) {
    CGRect frame = windowScene.effectiveGeometry.systemFrame;
    if (VeyraNMacFrameIsUsable(frame)) {
      [[NSUserDefaults standardUserDefaults] setObject:NSStringFromCGRect(frame)
                                                forKey:VeyraNMacWindowFrameKey];
    }
  }
}
#endif

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:[UIWindowScene class]]) {
    return;
  }
  UIWindowScene *windowScene = (UIWindowScene *)scene;
  AppDelegate *appDelegate = (AppDelegate *)[UIApplication sharedApplication].delegate;

#if TARGET_OS_MACCATALYST
  // The window is a document-less Mac window: the title sits in the toolbar
  // band (like Apple Notes, JS pushes it in through
  // VeyraNMacMenu.setWindowTitle), there is no separator, and the toolbar
  // carries the app's own controls (the list's menu, New Note, the editor
  // actions, search). Setting a toolbar also gives the content area a real top
  // edge - Catalyst lays the window's content out *below* the toolbar - so the
  // title bar material no longer floats over (and dims) the app's headers.
  windowScene.titlebar.titleVisibility = UITitlebarTitleVisibilityVisible;
  if (@available(macCatalyst 14.0, *)) {
    windowScene.titlebar.separatorStyle = UITitlebarSeparatorStyleNone;
  }
  self.macToolbar = [[VeyraNMacToolbar alloc] initWithWindowScene:windowScene];
  windowScene.sizeRestrictions.minimumSize = VeyraNMacMinimumWindowSize;
  VeyraNMacRestoreWindowFrame(windowScene);
#endif

  self.window = [[UIWindow alloc] initWithWindowScene:windowScene];
#if TARGET_OS_MACCATALYST
  // Mac's sidebar is a floating glass panel (see components/mac-sidebar.tsx
  // and ios/Notesnook/Glass/VeyraNGlassView.swift). Its Liquid Glass needs an
  // opaque backdrop to read as glass: Catalyst does not show the desktop
  // through a clear UIWindow, so a clear window made the material sample a
  // blank light backdrop and render as a light slab. The window is therefore
  // opaque and follows the app's appearance (VeyraNMacWindowBackgroundColor);
  // the list/editor panes keep their own opaque surfaces and the sidebar pane
  // stays transparent so its glass sits directly over this colour. (On
  // iPhone/iPad the floating tab bar leaves its safe-area inset translucent,
  // and without an explicit window colour that strip renders black;
  // systemBackground follows light/dark.)
  self.window.backgroundColor = VeyraNMacWindowBackgroundColor();
  self.window.opaque = YES;
#else
  self.window.backgroundColor = [UIColor systemBackgroundColor];
#endif
  // Keep code that still reads the app delegate's window working.
  appDelegate.window = self.window;

#if TARGET_OS_MACCATALYST
  // The window chrome (toolbar, search field, traffic lights) follows the
  // *system* appearance by default, which leaves a light app with dark chrome
  // whenever macOS runs dark. JS pushes the app's theme in as soon as React is
  // up; applying what it last asked for here covers the window that was just
  // created (and the first frames before React runs). Must come after the
  // window exists, since it is the window that carries the override.
  [VeyraNMacMenu applyWindowAppearanceToWindowScene:windowScene];
  [VeyraNMacMenu installPointerModifierTrackingOnWindow:self.window];
#endif

  // With scenes, the system delivers the launch URL / user activity / shortcut here
  // instead of in application:didFinishLaunchingWithOptions:. Rebuild the classic
  // launch options so React Native's Linking.getInitialURL keeps working.
  NSMutableDictionary *launchOptions = [NSMutableDictionary new];
  UIOpenURLContext *urlContext = connectionOptions.URLContexts.allObjects.firstObject;
  if (urlContext != nil) {
    launchOptions[UIApplicationLaunchOptionsURLKey] = urlContext.URL;
  }
  NSUserActivity *activity = connectionOptions.userActivities.allObjects.firstObject;
  if (activity != nil) {
    launchOptions[UIApplicationLaunchOptionsUserActivityDictionaryKey] = @{
      UIApplicationLaunchOptionsUserActivityTypeKey : activity.activityType,
      @"UIApplicationLaunchOptionsUserActivityKey" : activity
    };
  }
  if (connectionOptions.shortcutItem != nil) {
    launchOptions[UIApplicationLaunchOptionsShortcutItemKey] = connectionOptions.shortcutItem;
  }

  [appDelegate.reactNativeFactory startReactNativeWithModuleName:@"Notesnook"
                                                        inWindow:self.window
                                                   launchOptions:launchOptions];
#if TARGET_OS_MACCATALYST
  // The UIKit view backing the React root carries the same opaque colour as
  // the window, so the first frames (before React has drawn anything) are the
  // app's window colour instead of a light/clear sheet. React's own root then
  // paints the app's screen background on top.
  self.window.rootViewController.view.backgroundColor = VeyraNMacWindowBackgroundColor();
  self.window.rootViewController.view.opaque = YES;
#endif
  [self.window makeKeyAndVisible];

  if (connectionOptions.shortcutItem != nil) {
    [RNShortcuts performActionForShortcutItem:connectionOptions.shortcutItem
                            completionHandler:^(BOOL succeeded){
                            }];
  }
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  for (UIOpenURLContext *context in URLContexts) {
    [RCTLinkingManager application:[UIApplication sharedApplication] openURL:context.URL options:@{}];
  }
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  [RCTLinkingManager application:[UIApplication sharedApplication]
            continueUserActivity:userActivity
              restorationHandler:^(NSArray<id<UIUserActivityRestoring>> *_Nullable restorableObjects){
              }];
}

- (void)windowScene:(UIWindowScene *)windowScene
    performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem
               completionHandler:(void (^)(BOOL))completionHandler
{
  [RNShortcuts performActionForShortcutItem:shortcutItem completionHandler:completionHandler];
}

#if TARGET_OS_MACCATALYST
// W1: the scene reports every change of its size or position through this
// (older, still delivered) callback; each one updates the remembered frame,
// which the next launch restores in -scene:willConnectToSession:options:.
- (void)windowScene:(UIWindowScene *)windowScene
    didUpdateCoordinateSpace:(id<UICoordinateSpace>)previousCoordinateSpace
        interfaceOrientation:(UIInterfaceOrientation)previousInterfaceOrientation
             traitCollection:(UITraitCollection *)previousTraitCollection
{
  VeyraNMacSaveWindowFrame(windowScene);
}

// The frame is also saved whenever the window stops being the active one and
// when the scene goes away (Cmd-Q), which is when the user has finished
// resizing or moving it.
- (void)sceneDidEnterBackground:(UIScene *)scene
{
  if ([scene isKindOfClass:[UIWindowScene class]]) {
    VeyraNMacSaveWindowFrame((UIWindowScene *)scene);
  }
}

- (void)sceneWillResignActive:(UIScene *)scene
{
  if ([scene isKindOfClass:[UIWindowScene class]]) {
    VeyraNMacSaveWindowFrame((UIWindowScene *)scene);
  }
}

- (void)sceneDidDisconnect:(UIScene *)scene
{
  if ([scene isKindOfClass:[UIWindowScene class]]) {
    VeyraNMacSaveWindowFrame((UIWindowScene *)scene);
  }
}
#endif

@end

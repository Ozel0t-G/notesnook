#import "SceneDelegate.h"
#import "AppDelegate.h"
#import <React/RCTLinkingManager.h>
#import "RNShortcuts.h"

#if TARGET_OS_MACCATALYST
#import "MacMenu/VeyraNMacToolbar.h"

@interface SceneDelegate ()

/// The window's native toolbar. NSToolbar holds its delegate weakly, so the
/// object itself has to stay alive for as long as the window shows it.
@property (nonatomic, strong) VeyraNMacToolbar *macToolbar;

@end
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
  // The window is a document-less Mac window: no title, no separator, and a
  // toolbar that carries the app's own controls (Library/Tasks/Search and New
  // Note). Setting a toolbar also gives the content area a real top edge -
  // Catalyst lays the window's content out *below* the toolbar - so the title
  // bar material no longer floats over (and dims) the app's headers.
  windowScene.titlebar.titleVisibility = UITitlebarTitleVisibilityHidden;
  if (@available(macCatalyst 14.0, *)) {
    windowScene.titlebar.separatorStyle = UITitlebarSeparatorStyleNone;
  }
  self.macToolbar = [[VeyraNMacToolbar alloc] initWithWindowScene:windowScene];
  windowScene.sizeRestrictions.minimumSize = CGSizeMake(900, 600);
#endif

  self.window = [[UIWindow alloc] initWithWindowScene:windowScene];
  // The floating tab bar leaves its safe-area inset translucent. Without an
  // explicit window colour that strip renders black in both appearances;
  // systemBackground follows light/dark automatically.
  self.window.backgroundColor = [UIColor systemBackgroundColor];
  // Keep code that still reads the app delegate's window working.
  appDelegate.window = self.window;

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

@end

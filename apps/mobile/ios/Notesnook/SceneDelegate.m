#import "SceneDelegate.h"
#import "AppDelegate.h"
#import <React/RCTLinkingManager.h>
#import "RNShortcuts.h"

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
  // The macOS title bar is translucent and floats over the top ~30pt of the
  // React content, which hides the editor's back/undo/menu buttons. Drop the
  // title and the toolbar so the React view owns the whole content area, and
  // give the window a sensible minimum size.
  windowScene.titlebar.titleVisibility = UITitlebarTitleVisibilityHidden;
  windowScene.titlebar.toolbar = nil;
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

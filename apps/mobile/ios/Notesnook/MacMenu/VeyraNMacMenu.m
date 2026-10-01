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

#import "VeyraNMacMenu.h"

#if TARGET_OS_MACCATALYST
#import "VeyraNMacToolbar.h"

/**
 * `NSColor` and `NSColorSpace`: AppKit marks both classes unavailable on Mac
 * Catalyst, so the bridge cannot name them or their methods. These protocols
 * mirror only what the accent lookup needs; the classes are reached by name at
 * runtime and then messaged through the protocols, which keeps the calls typed
 * (and ARC quiet) without declaring an unavailable type. They sit above the
 * implementation because a protocol cannot be declared inside one.
 */
@protocol VeyraNMacAppKitColor <NSObject>
/** `+[NSColor controlAccentColor]`: the user's system accent colour. */
+ (id)controlAccentColor;
/** `-[NSColor colorUsingColorSpace:]`; nil when the colour cannot convert. */
- (id)colorUsingColorSpace:(id)colorSpace;
/** `-[NSColor CGColor]`: the Core Graphics colour behind the AppKit one. */
- (CGColorRef)CGColor;
@end

@protocol VeyraNMacAppKitColorSpace <NSObject>
/** `+[NSColorSpace sRGBColorSpace]`: the space the accent is converted into. */
+ (id)sRGBColorSpace;
@end
#endif


#if TARGET_OS_MACCATALYST
/// The modifier flags of the last pointer press in the window (main thread
/// writes, any thread reads; a plain word-sized value).
static volatile UIKeyModifierFlags VeyraNLastPointerModifiers = 0;

/**
 * A gesture recognizer that never recognizes anything: it only reads
 * `UIEvent.modifierFlags` when a press begins, and fails at once so it neither
 * delays nor cancels the touches React Native's views receive.
 */
@interface VeyraNPointerModifierRecognizer : UIGestureRecognizer
@end

@implementation VeyraNPointerModifierRecognizer
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  VeyraNLastPointerModifiers = event.modifierFlags;
  self.state = UIGestureRecognizerStateFailed;
}
@end
#endif

@implementation VeyraNMacMenu {
  BOOL _hasListeners;
#if TARGET_OS_MACCATALYST
  /** Whether the system state observers are registered (-startObserving). */
  BOOL _isObservingSystemState;
  /** Whether the last system state event filled in `_last...` to compare to. */
  BOOL _hasEmittedSystemState;
  /** The values of the last system state event, to drop unchanged repeats. */
  NSString *_lastSystemAccent;
  BOOL _lastWindowActive;
#endif
}

RCT_EXPORT_MODULE();

/**
 * The live module instance, if React Native created one. There is exactly one
 * JS bridge per process, so a single weak reference is enough for the
 * AppDelegate to reach JS from a menu action.
 */
static __weak VeyraNMacMenu *currentInstance = nil;

/**
 * The event that carries the system state (see -emitSystemStateIfChanged).
 * Named and shaped like VeyraNMacMenuCommand: JS subscribes through a
 * NativeEventEmitter and reads the body's `accent` and `active`.
 */
static NSString *const VeyraNMacSystemStateEvent = @"VeyraNMacSystemState";

/**
 * The accent the module reports when there is nothing to read it from: iOS'
 * own system blue (the dark appearance's value), which is also what the
 * non-Catalyst build answers. A hex string, not a colour, because the value
 * crosses the bridge as-is.
 */
static NSString *const VeyraNMacMenuDefaultAccent = @"#0A84FF";

#if TARGET_OS_MACCATALYST
/**
 * AppKit's "the system colours changed" notification, the one signal macOS
 * gives for a changed accent colour. The symbol and the NSColor class it lives
 * next to are both marked unavailable on Mac Catalyst, so the name is used as
 * a plain string: AppKit is loaded in every Catalyst process and still posts
 * it on the default notification centre.
 */
static NSString *const VeyraNMacSystemColorsDidChangeNotification =
    @"NSSystemColorsDidChangeNotification";

/**
 * The appearance the app asked for, remembered so windows that exist later
 * (a new scene, or a scene built before JS has spoken) can be brought in line
 * without another JS round trip. Unspecified means "follow the system", and is
 * also the state before JS sends anything.
 */
static UIUserInterfaceStyle currentWindowAppearanceStyle =
    UIUserInterfaceStyleUnspecified;

/**
 * The menu build context last published by JS (WP10/K4), read by the
 * AppDelegate's UIMenuBuilder. Both start NO so the commands that need a note
 * or a focused list are greyed until JS says otherwise. Only written on the
 * main queue (see -setContext:).
 */
static BOOL currentMenuContextHasNote = NO;
static BOOL currentMenuContextHasList = NO;

/**
 * Maps the JS string to UIKit's style. Unknown values fall back to the system
 * style instead of raising: a typo in JS must not take the window chrome down.
 */
static UIUserInterfaceStyle VeyraNWindowAppearanceForStyle(NSString *style) {
  if ([style isEqualToString:@"light"]) {
    return UIUserInterfaceStyleLight;
  }
  if ([style isEqualToString:@"dark"]) {
    return UIUserInterfaceStyleDark;
  }
  return UIUserInterfaceStyleUnspecified;
}

/**
 * One byte of a hex colour: a colour component clamped to 0...1 (the extended
 * sRGB space lets wide-gamut values sit outside it) and rounded to the nearest
 * 0...255.
 */
static unsigned int VeyraNMacMenuHexComponent(CGFloat value) {
  if (value <= 0.0) {
    return 0;
  }
  if (value >= 1.0) {
    return 255;
  }
  return (unsigned int)(value * 255.0 + 0.5);
}

/**
 * Formats a colour the way JS expects it: "#RRGGBB". `getRed:green:blue:alpha:`
 * resolves dynamic system colours, so a colour that the current appearance
 * leaves to the system still ends up as concrete components here. Answers nil
 * for colours that cannot be expressed as RGB (a pattern colour, for instance),
 * which lets the caller fall back.
 */
static NSString *VeyraNMacMenuHexFromColor(UIColor *color) {
  CGFloat red = 0;
  CGFloat green = 0;
  CGFloat blue = 0;
  CGFloat alpha = 0;
  if (color == nil ||
      ![color getRed:&red green:&green blue:&blue alpha:&alpha]) {
    return nil;
  }
  return [NSString stringWithFormat:@"#%02X%02X%02X",
                                    VeyraNMacMenuHexComponent(red),
                                    VeyraNMacMenuHexComponent(green),
                                    VeyraNMacMenuHexComponent(blue)];
}

/**
 * Converts an AppKit colour into a `UIColor`.
 *
 * The colour is converted into sRGB (through `+[NSColorSpace sRGBColorSpace]`
 * and `-colorUsingColorSpace:`) and then handed over with `-CGColor`, because
 * an accent that is already component-based stays dynamic, and `UIColor` needs
 * concrete sRGB components for the hex string. Every step is checked and
 * answers nil when the class, the method or the value is missing, which is what
 * makes the caller's fallback reachable.
 */
static UIColor *VeyraNMacMenuColorFromAppKitColor(id color) {
  if (color == nil) {
    return nil;
  }
  id sRGBColor = color;
  Class<VeyraNMacAppKitColorSpace> colorSpaceClass =
      (Class<VeyraNMacAppKitColorSpace>)NSClassFromString(@"NSColorSpace");
  if (colorSpaceClass != Nil &&
      [colorSpaceClass respondsToSelector:@selector(sRGBColorSpace)] &&
      [color respondsToSelector:@selector(colorUsingColorSpace:)]) {
    id colorSpace = [colorSpaceClass sRGBColorSpace];
    if (colorSpace != nil) {
      // A colour that is already sRGB comes back as itself; one that cannot be
      // converted comes back as nil, and the original is kept then.
      id converted = [(id<VeyraNMacAppKitColor>)color
          colorUsingColorSpace:colorSpace];
      if (converted != nil) {
        sRGBColor = converted;
      }
    }
  }
  if (![sRGBColor respondsToSelector:@selector(CGColor)]) {
    return nil;
  }
  CGColorRef cgColor = [(id<VeyraNMacAppKitColor>)sRGBColor CGColor];
  if (cgColor == NULL) {
    return nil;
  }
  return [UIColor colorWithCGColor:cgColor];
}

/**
 * The user's system accent colour as "#RRGGBB".
 *
 * On Mac Catalyst the accent lives in AppKit (`NSColor.controlAccentColor`) and
 * is not what the app's own tint colour resolves to once the theme has set one,
 * so it is read at runtime (see VeyraNMacMenuColorFromAppKitColor). When it
 * cannot be read - an AppKit build without the property, or a colour that does
 * not convert - the answer falls back to iOS' system blue, so JS always gets a
 * parseable colour rather than an absent key.
 */
static NSString *VeyraNMacMenuSystemAccentHex(void) {
  Class<VeyraNMacAppKitColor> colorClass =
      (Class<VeyraNMacAppKitColor>)NSClassFromString(@"NSColor");
  if (colorClass != Nil &&
      [colorClass respondsToSelector:@selector(controlAccentColor)]) {
    UIColor *color =
        VeyraNMacMenuColorFromAppKitColor([colorClass controlAccentColor]);
    NSString *hex = VeyraNMacMenuHexFromColor(color);
    if (hex != nil) {
      return hex;
    }
  }
  return VeyraNMacMenuHexFromColor(UIColor.systemBlueColor)
             ?: VeyraNMacMenuDefaultAccent;
}

/**
 * Whether the app's window counts as active, i.e. whether macOS draws
 * emphasised selection (the system accent instead of grey): a window of this
 * app is key *and* the app itself is frontmost, because an inactive Catalyst
 * app keeps its last key window. Reported as the `active` field of the system
 * state event and read on the main queue and nowhere else - window and
 * application state are UI state.
 *
 * Before the scene has built its window (the module is created during launch)
 * there is nothing that could be inactive, so it answers the optimistic default
 * YES, the same value the `windowActive` constant documents.
 */
static BOOL VeyraNMacMenuWindowIsActive(void) {
  UIApplication *application = UIApplication.sharedApplication;
  BOOL hasWindow = NO;
  BOOL hasKeyWindow = NO;
  for (UIScene *scene in application.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) {
      continue;
    }
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      hasWindow = YES;
      if (window.isKeyWindow) {
        hasKeyWindow = YES;
      }
    }
  }
  if (!hasWindow) {
    return YES;
  }
  if (!hasKeyWindow) {
    return NO;
  }
  // UIKit's applicationState stays Active on Catalyst while another app is in
  // front (a window launched in the background still reports Active), so the
  // AppKit application is asked as well.
  Class appKitApplication = NSClassFromString(@"NSApplication");
  id shared = [appKitApplication respondsToSelector:@selector(sharedApplication)]
                  ? [appKitApplication valueForKey:@"sharedApplication"]
                  : nil;
  if (shared != nil && [shared respondsToSelector:NSSelectorFromString(@"isActive")]) {
    return [[shared valueForKey:@"active"] boolValue];
  }
  return application.applicationState == UIApplicationStateActive;
}
#endif

- (instancetype)init {
  if (self = [super init]) {
    currentInstance = self;
  }
  return self;
}

/**
 * The module is created on the main queue because its constants sample UI state
 * (`systemAccent` reads AppKit's accent colour, `windowActive` the key window),
 * and the state observers are registered there as well. Everything else the
 * module does already hops to the main queue on its own, so this only decides
 * where `init` and `constantsToExport` run.
 */
+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"VeyraNMacMenuCommand", VeyraNMacSystemStateEvent ];
}

/**
 * Constants JS reads before any command arrives. `toolbarSearch` says whether
 * the window toolbar carries its own search field: the Search screen hides its
 * in-app title and field only when it does (see
 * +[VeyraNMacToolbar toolbarSearchAvailable]). `toolbarHeight` is the toolbar
 * band's measured height in points, 0 while it could not be measured yet (the
 * window is not laid out when this runs) - `getToolbarHeight` measures again on
 * the main queue then.
 *
 * `systemAccent` is the user's accent colour as "#RRGGBB" and `windowActive`
 * whether a window of this app is key while the app is frontmost. The same pair
 * arrives with every VeyraNMacSystemState event and can be re-read with
 * `getSystemState`; the constants are sampled once, during launch, when the
 * scene may not have built its window yet, so `windowActive` is optimistic
 * there (an app without a window counts as active) and the first event corrects
 * it as soon as the window exists. On iPhone and iPad both keep their
 * documented defaults ("#0A84FF" / YES), because the module is inert there.
 */
- (NSDictionary *)constantsToExport {
#if TARGET_OS_MACCATALYST
  return @{
    @"toolbarSearch" : @([VeyraNMacToolbar toolbarSearchAvailable]),
    @"toolbarHeight" : @([VeyraNMacToolbar toolbarHeight]),
    @"systemAccent" : VeyraNMacMenuSystemAccentHex(),
    @"windowActive" : @(VeyraNMacMenuWindowIsActive())
  };
#else
  return @{
    @"toolbarSearch" : @NO,
    @"toolbarHeight" : @0,
    @"systemAccent" : VeyraNMacMenuDefaultAccent,
    @"windowActive" : @YES
  };
#endif
}

- (void)startObserving {
  currentInstance = self;
  _hasListeners = YES;
#if TARGET_OS_MACCATALYST
  [self startObservingSystemState];
#endif
}

- (void)stopObserving {
  _hasListeners = NO;
#if TARGET_OS_MACCATALYST
  [self stopObservingSystemState];
#endif
}

- (void)dealloc {
  // The notification centre does not retain its observers: a module that goes
  // away without -stopObserving would leave a dangling registration behind.
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

#if TARGET_OS_MACCATALYST
/**
 * Subscribes to the notifications that can move the system state and publishes
 * the current values once.
 *
 * The window notifications are the direct signal for the `active` half (a
 * window becoming or resigning key), the application ones catch an app that is
 * activated without a window changing key, and the accent half is driven by
 * AppKit's system-colour notification - the only thing macOS posts for a
 * changed accent colour. There is no trait to observe for it (the accent is not
 * a UITraitCollection member, changing it leaves the trait collection alone),
 * so the re-read on the activation notifications also serves as the fallback
 * for a system that does not post the AppKit one: changing the accent means
 * leaving the app for System Settings and coming back.
 *
 * Only called from -startObserving, i.e. while JS has a listener attached, and
 * the first event is forced out (`_hasEmittedSystemState` starts NO) so JS does
 * not have to rely on the constants, which were read earlier, during launch.
 */
- (void)startObservingSystemState {
  if (_isObservingSystemState) {
    return;
  }
  _isObservingSystemState = YES;
  _hasEmittedSystemState = NO;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (NSString *name in @[
         UIWindowDidBecomeKeyNotification,
         UIWindowDidResignKeyNotification,
         UIApplicationDidBecomeActiveNotification,
         UIApplicationWillResignActiveNotification,
         VeyraNMacSystemColorsDidChangeNotification,
         @"NSApplicationDidBecomeActiveNotification",
         @"NSApplicationDidResignActiveNotification"
       ]) {
    [center addObserver:self
               selector:@selector(systemStateDidChange:)
                   name:name
                 object:nil];
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self emitSystemStateIfChanged];
  });
}

/**
 * Drops the subscriptions again, so a module without listeners does not keep
 * sampling. The next -startObservingSystemState re-reads everything, so nothing
 * that changed meanwhile is lost.
 */
- (void)stopObservingSystemState {
  if (!_isObservingSystemState) {
    return;
  }
  _isObservingSystemState = NO;
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

/**
 * One of the observed notifications fired. AppKit posts its colour change on
 * the main thread and the UIKit ones mostly do too, but this samples UI state,
 * so the sample always runs on the main queue.
 */
- (void)systemStateDidChange:(NSNotification *)notification {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self emitSystemStateIfChanged];
  });
}

/**
 * Sends the VeyraNMacSystemState event when the accent colour or the window's
 * active state differs from the last event JS got, and does nothing otherwise:
 * the notifications fire more often than the value changes (every window of
 * every scene reports its key changes, and becoming active posts on top).
 */
- (void)emitSystemStateIfChanged {
  if (!_hasListeners) {
    return;
  }
  NSString *accent = VeyraNMacMenuSystemAccentHex();
  BOOL active = VeyraNMacMenuWindowIsActive();
  if (_hasEmittedSystemState && [accent isEqualToString:_lastSystemAccent] &&
      active == _lastWindowActive) {
    return;
  }
  _hasEmittedSystemState = YES;
  _lastSystemAccent = accent;
  _lastWindowActive = active;
  // The two keys are always present, like VeyraNMacMenuCommand's, so JS never
  // has to guard for a missing one.
  [self sendEventWithName:VeyraNMacSystemStateEvent
                     body:@{@"accent" : accent, @"active" : @(active)}];
}
#endif

+ (void)sendCommand:(NSString *)command {
  [self sendCommand:command text:nil];
}

+ (void)sendCommand:(NSString *)command text:(NSString *)text {
  VeyraNMacMenu *instance = currentInstance;
  if (instance == nil || !instance->_hasListeners) {
    // No JS listener attached (or the bridge is gone): drop the event.
    return;
  }
  // Every command keeps the same two keys: commands without a payload get an
  // empty string rather than a missing key, so JS never has to guard for it.
  [instance sendEventWithName:@"VeyraNMacMenuCommand"
                         body:@{
                           @"command" : command ?: @"",
                           @"text" : text ?: @""
                         }];
}

/**
 * Keeps the toolbar's leading item in sync with the app's own section state:
 * everything that switches sections (the sidebar, deep links, the section
 * store) changes the store, not the toolbar, so JS pushes the new value back
 * here - which is what turns the New item into "New Task" and what focuses the
 * search field for the Search section.
 */
RCT_EXPORT_METHOD(setSelectedSection:(NSString *)section) {
#if TARGET_OS_MACCATALYST
  [VeyraNMacToolbar setSelectedSection:section];
#endif
}

/**
 * Sets the window title and subtitle (the current note or list and its
 * context). SceneDelegate shows the title (UITitlebarTitleVisibilityVisible),
 * so this is what makes the window name what the app is showing, the way Apple
 * Notes does.
 *
 * Scene state is UI state, so +[VeyraNMacToolbar setWindowTitle:subtitle:] hops
 * to the main queue; an empty title clears it and an empty subtitle hides the
 * subtitle.
 */
RCT_EXPORT_METHOD(setWindowTitle:(NSString *)title
                       subtitle:(NSString *)subtitle) {
#if TARGET_OS_MACCATALYST
  [VeyraNMacToolbar setWindowTitle:title subtitle:subtitle];
#endif
}

/**
 * The menu build context, published by JS whenever it changes (WP10/K4):
 * `noteOpen` says whether a note is open in the editor, `listOpen` whether a
 * list has published its own menu (useMacWindowStore.listMenu, which View >
 * Sort By / Group By forward to). JS's hook (use-mac-menu-commands.ts) calls
 * this from the stores; a missing key counts as NO.
 *
 * The flags are only ever written on the main queue - they are read by
 * -buildMenuWithBuilder: / -validateCommand: there - and the menu is only
 * rebuilt when a value really changed, so this stays cheap while the stores
 * change often. On iPhone and iPad the method is inert (the module is looked
 * up unconditionally by JS).
 */
RCT_EXPORT_METHOD(setContext:(NSDictionary *)context) {
#if TARGET_OS_MACCATALYST
  BOOL hasNote = [context[@"noteOpen"] boolValue];
  BOOL hasList = [context[@"listOpen"] boolValue];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (hasNote == currentMenuContextHasNote &&
        hasList == currentMenuContextHasList) {
      return;
    }
    currentMenuContextHasNote = hasNote;
    currentMenuContextHasList = hasList;
    // setNeedsRebuild (not setNeedsRevalidate) because the disabled state is
    // applied while the menus are built, not only validated.
    [UIMenuSystem.mainSystem setNeedsRebuild];
  });
#endif
}

/**
 * Measures the window toolbar's height and resolves with it in points. JS reads
 * the `toolbarHeight` constant at startup, when the window is not laid out yet
 * and the constant is still 0; this asks for the measurement once there is a
 * window to measure (and re-measures on every call, so a window that was
 * resized or recreated reports its current band).
 *
 * Window state is main-thread only, so the measurement hops there; it never
 * rejects (0 simply means "no window on screen yet").
 */
RCT_EXPORT_METHOD(getToolbarHeight:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
#if TARGET_OS_MACCATALYST
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@([VeyraNMacToolbar measureToolbarHeight]));
  });
#else
  resolve(@0);
#endif
}

/**
 * The modifier keys held at the last pointer press, for Cmd-click / Shift-click
 * selection in the note list (WP07/N2). Synchronous, because the press handler
 * needs the answer right away; inert (all NO) on iPhone and iPad.
 */
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getPointerModifiers) {
#if TARGET_OS_MACCATALYST
  UIKeyModifierFlags flags = VeyraNLastPointerModifiers;
  return @{
    @"cmd" : @((flags & UIKeyModifierCommand) != 0),
    @"shift" : @((flags & UIKeyModifierShift) != 0),
    @"alt" : @((flags & UIKeyModifierAlternate) != 0)
  };
#else
  return @{@"cmd" : @NO, @"shift" : @NO, @"alt" : @NO};
#endif
}

/**
 * Resolves with the same { accent, active } the `systemAccent` and
 * `windowActive` constants carry and the VeyraNMacSystemState event repeats,
 * sampled now rather than at launch: JS calls this when it needs the state of
 * the window that is actually on screen (the constants are read before the
 * scene may have one).
 *
 * Both values are main-thread state (the accent is AppKit's, the window the
 * app's), so the sample hops there; it never rejects, and on iPhone and iPad -
 * where the module is inert - it answers the same defaults as the constants.
 */
RCT_EXPORT_METHOD(getSystemState:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
#if TARGET_OS_MACCATALYST
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@{
      @"accent" : VeyraNMacMenuSystemAccentHex(),
      @"active" : @(VeyraNMacMenuWindowIsActive())
    });
  });
#else
  resolve(@{@"accent" : VeyraNMacMenuDefaultAccent, @"active" : @YES});
#endif
}

/**
 * Mirrors the app's theme onto the window chrome. The app can be light while
 * macOS is dark (or the other way round, `useSystemTheme` off): the React
 * content follows the app's theme, but the NSToolbar (its segmented control,
 * the search field, the traffic lights and every menu attached to them) stays
 * in the system appearance, which makes a light app sit under a dark title bar.
 * `overrideUserInterfaceStyle` on the window is the one public switch that
 * moves all of that chrome to the app's appearance, and it is per window, so
 * only the window(s) of this process change - the system-wide appearance and
 * the appearance of other apps are untouched.
 *
 * `style` is "light", "dark" or "system"; anything else (including "system")
 * clears the override and lets the window follow the system again.
 *
 * Windows only exist on the main thread, and JS calls this from the module's
 * queue, so the work hops there and is remembered for windows created later
 * (see +applyWindowAppearanceToWindowScene:).
 */
RCT_EXPORT_METHOD(setWindowAppearance:(NSString *)style) {
#if TARGET_OS_MACCATALYST
  UIUserInterfaceStyle appearance = VeyraNWindowAppearanceForStyle(style);
  dispatch_async(dispatch_get_main_queue(), ^{
    currentWindowAppearanceStyle = appearance;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) {
        continue;
      }
      [VeyraNMacMenu applyWindowAppearanceToWindowScene:(UIWindowScene *)scene];
    }
  });
#endif
}

#if TARGET_OS_MACCATALYST
+ (void)installPointerModifierTrackingOnWindow:(UIWindow *)window {
#if TARGET_OS_MACCATALYST
  VeyraNPointerModifierRecognizer *recognizer =
      [[VeyraNPointerModifierRecognizer alloc] init];
  recognizer.cancelsTouchesInView = NO;
  recognizer.delaysTouchesBegan = NO;
  recognizer.delaysTouchesEnded = NO;
  [window addGestureRecognizer:recognizer];
#endif
}

+ (void)applyWindowAppearanceToWindowScene:(UIWindowScene *)scene {
  UIUserInterfaceStyle appearance = currentWindowAppearanceStyle;
  for (UIWindow *window in scene.windows) {
    window.overrideUserInterfaceStyle = appearance;
  }
}

+ (BOOL)menuContextHasNote {
  return currentMenuContextHasNote;
}

+ (BOOL)menuContextHasList {
  return currentMenuContextHasList;
}
#endif

@end

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

#if TARGET_OS_MACCATALYST

#import <UIKit/UIKit.h>
#import <objc/runtime.h>

/**
 * Turns off UIKit's system "scroll edge effect" on every scroll view.
 *
 * On macOS 26 and newer UIKit puts a scroll edge effect at the top of every
 * UIScrollView that sits under the window's unified toolbar. On Mac Catalyst
 * the automatic style resolves to the hard one, so the system paints a slightly
 * lighter band with a hairline across the React Native scroll views of the
 * sidebar and note list at the toolbar's lower edge (y ~ 51 pt). The app draws
 * its own soft fade there already, so the two effects overlap and the system
 * band and hairline are visibly wrong.
 *
 * The effect is a per-scroll-view object (UIScrollView.topEdgeEffect, iOS 26)
 * and the only switch that turns it off is its `hidden` property; there is no
 * window- or app-wide opt-out, and the effect is re-evaluated when the view
 * moves into a window. `didMoveToWindow` is therefore the hook: the category
 * swaps it once, at image load, and the replacement hides the effect right
 * after UIKit has had its say - including for the scroll views React Native
 * creates later, which no launch-time enumeration could reach.
 *
 * Catalyst only: on iPhone and iPad the system effect is the intended look and
 * the file compiles to nothing. The category has no header - it adds no API to
 * call, it only installs the swizzle through +load.
 */
@implementation UIScrollView (VeyraNEdgeEffect)

/**
 * Installs the swizzle exactly once, the first time the Objective-C runtime
 * loads the image containing this category. UIScrollView may inherit
 * `didMoveToWindow` from UIView, so the method is first added to UIScrollView
 * itself; exchanging the inherited UIView method directly would rewire every
 * view and crash plain views with an unrecognized selector.
 */
+ (void)load {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Class cls = [UIScrollView class];
    SEL originalSelector = @selector(didMoveToWindow);
    SEL replacementSelector = @selector(veyraN_didMoveToWindow);
    Method original = class_getInstanceMethod(cls, originalSelector);
    Method replacement = class_getInstanceMethod(cls, replacementSelector);
    if (original == NULL || replacement == NULL) return;
    BOOL added = class_addMethod(cls, originalSelector,
                                 method_getImplementation(replacement),
                                 method_getTypeEncoding(replacement));
    if (added) {
      class_replaceMethod(cls, replacementSelector,
                          method_getImplementation(original),
                          method_getTypeEncoding(original));
    } else {
      method_exchangeImplementations(original, replacement);
    }
  });
}

/**
 * The swizzled `didMoveToWindow`. After the exchange this selector holds the
 * original implementation, so the first call is UIKit's own; it is followed by
 * the effect's removal, which has to happen after the move because UIKit
 * rebuilds the edge effect while the view enters the window.
 *
 * `topEdgeEffect` does not exist before iOS 26 (the app still supports older
 * systems), so the access is guarded. The property is never nil there - it is
 * created on demand - and `hidden` is the documented off switch.
 */
- (void)veyraN_didMoveToWindow {
  // Resolves to UIScrollView's -didMoveToWindow after the exchange.
  [self veyraN_didMoveToWindow];
  if (@available(iOS 26.0, *)) {
    if ([self respondsToSelector:@selector(topEdgeEffect)]) {
      UIScrollEdgeEffect *effect = self.topEdgeEffect;
      if ([effect respondsToSelector:@selector(setHidden:)]) {
        effect.hidden = YES;
      }
    }
  }
}

@end

#endif

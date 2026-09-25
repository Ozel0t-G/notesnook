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

#import "TaskWidgetReactHost.h"
#import "../AppDelegate.h"
#import <React/RCTLog.h>
#import <UIKit/UIKit.h>

@implementation TaskWidgetReactHost

+ (void)ensureStarted:(void (^)(BOOL))completion
{
  // The application delegate and the React Native factory are only safe to
  // touch on the main thread, and the intent's perform() is not on it.
  dispatch_async(dispatch_get_main_queue(), ^{
    id<UIApplicationDelegate> delegate = UIApplication.sharedApplication.delegate;
    if (![delegate isKindOfClass:[AppDelegate class]]) {
      RCTLogError(@"Task widget completion has no application delegate");
      completion(NO);
      return;
    }
    RCTReactNativeFactory *factory = ((AppDelegate *)delegate).reactNativeFactory;
    if (factory == nil || factory.rootViewFactory == nil) {
      RCTLogError(@"Task widget completion has no React Native factory");
      completion(NO);
      return;
    }
    @try {
      // Idempotent: it returns immediately once a host exists, so a widget tap
      // while the app is in the foreground reuses the running instance and its
      // already-open database.
      [factory.rootViewFactory initializeReactHostWithLaunchOptions:@{}];
    } @catch (NSException *exception) {
      RCTLogError(@"Task widget completion could not start React Native: %@", exception.reason);
      completion(NO);
      return;
    }
    completion(YES);
  });
}

@end

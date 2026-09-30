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
#endif

@implementation VeyraNMacMenu {
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE();

/**
 * The live module instance, if React Native created one. There is exactly one
 * JS bridge per process, so a single weak reference is enough for the
 * AppDelegate to reach JS from a menu action.
 */
static __weak VeyraNMacMenu *currentInstance = nil;

- (instancetype)init {
  if (self = [super init]) {
    currentInstance = self;
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"VeyraNMacMenuCommand" ];
}

- (void)startObserving {
  currentInstance = self;
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

+ (void)sendCommand:(NSString *)command {
  VeyraNMacMenu *instance = currentInstance;
  if (instance == nil || !instance->_hasListeners) {
    // No JS listener attached (or the bridge is gone): drop the event.
    return;
  }
  [instance sendEventWithName:@"VeyraNMacMenuCommand" body:@{@"command" : command}];
}

/**
 * Keeps the toolbar's segmented control in sync with the app's own section
 * state: everything that switches sections (deep links, the section store)
 * changes the store, not the toolbar, so JS pushes the new value back here.
 */
RCT_EXPORT_METHOD(setSelectedSection:(NSString *)section) {
#if TARGET_OS_MACCATALYST
  [VeyraNMacToolbar setSelectedSection:section];
#endif
}

@end

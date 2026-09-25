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

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface TaskWidgetReactHost : NSObject

/**
 * Starts the React Native instance without a window, a surface or a root view,
 * and reports whether it is running.
 *
 * The Task widget's completion intent can launch this process in the background
 * with no scene at all, which is where the UI would normally start React
 * Native. Loading the bundle registers the app component but does not mount it,
 * so no App, navigation or editor is created; only the top-level services in
 * index.js run. Calling this when the UI has already started React Native does
 * nothing.
 */
+ (void)ensureStarted:(void (^)(BOOL started))completion;

@end

NS_ASSUME_NONNULL_END

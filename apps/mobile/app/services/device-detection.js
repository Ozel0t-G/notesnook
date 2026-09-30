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

import { Dimensions, PixelRatio, Platform } from "react-native";
import DeviceInfo from "react-native-device-info";
import { isMacCatalyst } from "../utils/constants";

let windowSize = Dimensions.get("window");
let screenSize = Dimensions.get("screen");
export class DeviceDetectionService {
  constructor() {
    this.setNewValues();
  }

  /**
   * Mac Catalyst is reported as a tablet on purpose. The Mac build is the
   * "Optimize Interface for Mac" build, so `UIDevice.userInterfaceIdiom` is
   * `.mac` and react-native-device-info answers `false` here - but the Mac
   * window lays out like the iPad (three panes side by side, dialogs and
   * sheets at tablet widths, no phone chrome). Every `DDS.isTab` call site
   * wants that answer on Mac, and iPhone/iPad are untouched because
   * `isMacCatalyst()` is false there.
   */
  isTablet() {
    return DeviceInfo.isTablet() || isMacCatalyst();
  }
  setNewValues() {
    screenSize = Dimensions.get("screen");
    windowSize = Dimensions.get("window");
    this.pixelDensity = PixelRatio.get();
    this.width = windowSize.width;
    this.height = windowSize.height;
    this.adjustedWidth = this.width * this.pixelDensity;
    this.adjustedHeight = this.height * this.pixelDensity;
    this.screenWidth = screenSize.width;
    this.screenHeight = screenSize.height;
    this.isPhoneOrTablet();
    this.isIosOrAndroid();
    this.detectIphoneX();
    this.checkSmallTab();
  }

  setSize(size, orientation) {
    windowSize = size || windowSize;
    this.width = windowSize.width;
    this.height = windowSize.height;
    this.orientation = orientation;
    this.adjustedWidth = this.width * this.pixelDensity;
    this.adjustedHeight = this.height * this.pixelDensity;
    screenSize = Dimensions.get("screen");
    this.screenWidth = screenSize.width;
    this.screenHeight = screenSize.height;
    this.isPhoneOrTablet();
    this.isIosOrAndroid();
    this.detectIphoneX();
    this.checkSmallTab(orientation);
  }

  getDeviceSize = () => {
    let size = this.width / 100;
    return size;
  };

  getScreenSize = () => {
    let size = this.screenWidth / 100;
    return size;
  };

  checkSmallTab(orientation) {
    /**
     * Mac Catalyst is always the large-tablet layout: the window is a desktop
     * window (mac-layout.ts sizes the panes from its width) and the app pins
     * `deviceMode` to `tablet` there, so the phone/small-tablet heuristics
     * below - which are driven by the window's diagonal in inches - must not
     * apply. Left to them, every common Mac window width would read as a small
     * tablet. iPhone/iPad never enter this branch.
     */
    if (isMacCatalyst()) {
      this.isTab = true;
      this.isPhone = false;
      this.isSmallTab = false;
      return;
    }

    let deviceSize = this.getDeviceSize();

    const isLandscape = orientation?.startsWith("LANDSCAPE");
    const isValidTabletSize = deviceSize > 5.5;
    const isValidLargeTabletSize = deviceSize > 9;

    if (
      (!this.isTablet() && isLandscape && isValidTabletSize) ||
      (this.isTablet() && isValidTabletSize && !isValidLargeTabletSize)
    ) {
      this.isTab = true;
      this.isPhone = false;
      this.isSmallTab = true;
    } else if (this.isTablet() && isLandscape && isValidLargeTabletSize) {
      this.isTab = true;
      this.isPhone = false;
      this.isSmallTab = false;
    } else {
      if (!this.isTablet() || deviceSize < 5.5) {
        this.isTab = false;
        this.isPhone = true;
        this.isSmallTab = false;
      } else {
        this.isTab = true;
        this.isSmallTab = true;
        this.isPhone = false;
      }
    }
  }

  isPhoneOrTablet() {
    if (this.isTablet()) {
      this.isTab = true;
      this.isPhone = false;
    } else {
      this.isTab = false;
      this.isPhone = false;
    }
  }

  isIosOrAndroid() {
    if (Platform.OS === "ios") {
      this.isIos = true;
      this.isAndroid = false;
    } else {
      this.isIos = false;
      this.isAndroid = true;
    }
  }

  detectIphoneX() {
    this.isIphoneX =
      Platform.OS === "ios" &&
      !Platform.isTVOS &&
      !Platform.isTVOS &&
      (windowSize.height === 812 || windowSize.width === 812);
  }

  isLargeTablet() {
    return this.isTab && !this.isSmallTab;
  }
}

export const DDS = new DeviceDetectionService();

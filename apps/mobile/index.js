/* eslint-disable @typescript-eslint/no-var-requires */
import NetInfo from "@react-native-community/netinfo";
import React from "react";
import { AppRegistry, LogBox } from "react-native";
import Config from "react-native-config";
import "react-native-get-random-values";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { enableFreeze } from "react-native-screens";
import { AppIntentHost } from "./app/services/app-intent-host";
import { BackgroundSync } from "./app/services/background-sync";
import Notifications from "./app/services/notifications";
import { TaskWidgetCompletionHost } from "./app/services/task-widget-completion-host";
import appJson from "./app.json";
import "./globals.js";

BackgroundSync.registerHeadlessTask();
BackgroundSync.start();
Notifications.init();
// The Task widget's completion intent runs in this process in the background,
// possibly on a cold start where no surface is ever mounted. It is answered
// here, at the top level, rather than from the App component.
TaskWidgetCompletionHost.start();
// The Shortcuts actions that do not open the app — the Task parameter picker,
// Complete Task and Today's Tasks — reach this process the same way, so they are
// answered here rather than from the App component.
AppIntentHost.start();

enableFreeze(true);
NetInfo.configure({
  reachabilityUrl: "https://api.notesnook.com/health",
  reachabilityTest: (response) => {
    if (!response) return false;
    console.log("reachabilty test", response.status);
    return response?.status >= 200 && response?.status < 300;
  }
});

const appName = appJson.name;
if (Config.isTesting) {
  Date.prototype.toLocaleString = () => "XX-XX-XX";
}

if (__DEV__) {
  console.warn = () => null;
  LogBox.ignoreAllLogs();
}

const AppProvider = () => {
  const App = require("./app/app").default;
  return <App />;
};

AppRegistry.registerComponent(appName, () => AppProvider);

const NotePreviewConfigureProvider = () => {
  const App = require("./app/app").default;
  return <App configureMode="note-preview" />;
};

AppRegistry.registerComponent(
  "NotePreviewConfigure",
  () => NotePreviewConfigureProvider
);

const ShareProvider = () => {
  let NotesnookShare = require("./app/share/index").default;
  return (
    <SafeAreaProvider>
      <NotesnookShare />
    </SafeAreaProvider>
  );
};

AppRegistry.registerComponent("NotesnookShare", () => ShareProvider);

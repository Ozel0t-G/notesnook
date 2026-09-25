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

import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  Platform
} from "react-native";
import { rootNavigatorRef } from "../utils/global-refs";
import { DatabaseLogger } from "../common/database";
import {
  AppIntentRequest,
  executeAppIntentRequest
} from "./app-intent-requests";

type IntentModule = {
  pendingRequests(): Promise<AppIntentRequest[]>;
  acknowledge(id: string, status: string, value: string): Promise<void>;
  consumeCaptureTarget(): Promise<"task" | "note" | null>;
};

let draining = false;
let drainAgain = false;

async function drain(module: IntentModule) {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      const requests = await module.pendingRequests();
      for (const request of requests) {
        if (!request?.id || !request?.action || !request?.payload) {
          DatabaseLogger.error(
            new Error("Malformed native App Intent request"),
            "AppIntent.drain"
          );
          if (request?.id)
            await module.acknowledge(request.id, "invalid", "");
          continue;
        }
        const reply = await executeAppIntentRequest(request);
        await module.acknowledge(request.id, reply.status, reply.value);
      }
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

export function startAppIntentBridge(
  appReady: boolean,
  unlocked: boolean,
  onCapture: (target: "task" | "note") => void
) {
  if (Platform.OS !== "ios") return () => {};
  const module = NativeModules.VeyraNIntentModule as IntentModule | undefined;
  if (!module) return () => {};
  const requestDrain = () => {
    if (appReady)
      void drain(module).catch((error) => {
        DatabaseLogger.error(error as Error, "AppIntent.drain");
      });
  };
  let active = true;
  let consumingCapture = false;
  const requestCapture = async () => {
    if (!appReady || !unlocked || consumingCapture || !active) return;
    if (!rootNavigatorRef.current?.isReady()) {
      setTimeout(() => {
        if (active)
          void requestCapture().catch((error) => {
            DatabaseLogger.error(error as Error, "AppIntent.capture");
          });
      }, 250);
      return;
    }
    consumingCapture = true;
    try {
      const target = await module.consumeCaptureTarget();
      if (active && (target === "task" || target === "note")) onCapture(target);
    } finally {
      consumingCapture = false;
    }
  };
  const emitter = new NativeEventEmitter(module as never);
  const pending = emitter.addListener("pendingIntent", requestDrain);
  const capture = emitter.addListener("pendingCapture", () => {
    void requestCapture().catch((error) => {
      DatabaseLogger.error(error as Error, "AppIntent.capture");
    });
  });
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      requestDrain();
      void requestCapture().catch((error) => {
        DatabaseLogger.error(error as Error, "AppIntent.capture");
      });
    }
  });
  requestDrain();
  void requestCapture().catch((error) => {
    DatabaseLogger.error(error as Error, "AppIntent.capture");
  });
  return () => {
    active = false;
    pending.remove();
    capture.remove();
    foreground.remove();
  };
}

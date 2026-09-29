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

import { strings } from "@notesnook/intl";
import notifee, { AuthorizationStatus } from "@notifee/react-native";
import React from "react";
import { AppState } from "react-native";
import { urgentStatus } from "../../services/task-alarms";

/**
 * The live status shown on the "Notifications & Alarms" row, re-read when the
 * app comes back from the Settings app.
 */
export function useNotificationAlarmStatus() {
  const [status, setStatus] = React.useState<string>("");
  React.useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const [settings, alarms] = await Promise.all([
          notifee.getNotificationSettings(),
          urgentStatus().catch(() => "unsupported" as const)
        ]);
        if (!alive) return;
        if (settings.authorizationStatus === AuthorizationStatus.DENIED)
          setStatus(strings.notificationsOff());
        else if (alarms === "authorized") setStatus(strings.alarmsAllowed());
        else if (alarms === "unsupported")
          setStatus(strings.alarmsUnavailable());
        else setStatus(strings.alarmsNotAllowed());
      } catch {
        if (alive) setStatus("");
      }
    };
    void read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return status;
}

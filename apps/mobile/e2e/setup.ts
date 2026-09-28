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

import { device } from "detox";

beforeAll(async () => {
  // Live VeyraN Events keeps SSE open. Scope its synchronization override to
  // the explicit iOS account QA suites; retain normal timing for other tests.
  const liveAccountQa =
    device.getPlatform() === "ios" &&
    (process.env.VEYRAN_QA_ACCOUNT_ENTRY === "1" ||
      (!!process.env.VEYRAN_QA_CREDENTIAL_FILE &&
        !!process.env.VEYRAN_QA_MFA_CODE_FILE) ||
      process.env.VEYRAN_QA_RETAINED_ACCOUNT_FEATURES === "true" ||
      ["baseline", "verify"].includes(
        process.env.VEYRAN_QA_UPGRADE_PHASE || ""
      ) ||
      process.env.VEYRAN_QA_AUTH_UPGRADE === "1");
  if (liveAccountQa) {
    await device.launchApp({ launchArgs: { detoxEnableSynchronization: 0 } });
    await device.disableSynchronization();
  } else {
    await device.launchApp();
  }
});

export {};

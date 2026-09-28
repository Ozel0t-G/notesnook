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

import { DatabaseLogger, db } from "../common/database";

/** Restore cached identity without making network availability a UI gate. */
export async function readStoredAccountSession(recoverInterrupted = false) {
  let recovered = false;
  let recoveryFailed = false;
  if (recoverInterrupted) {
    try {
      recovered = await db.user.recoverInterruptedSignup();
    } catch (error) {
      recoveryFailed = true;
      DatabaseLogger.error(error, "Interrupted account setup needs attention");
    }
  }
  const user = await db.user.getUser();
  if (!user) return { user, recovered, setupRequired: recoveryFailed };
  try {
    // An expired access token with a refresh credential is a normal restart.
    // Fetch/refresh handles it later; this proof only checks local integrity.
    const ready = await db.user.assertAccountReady({
      allowExpiredSession: true
    });
    return { ...ready, recovered, setupRequired: recoveryFailed };
  } catch (error) {
    DatabaseLogger.error(error, "Stored account setup needs attention");
    // Never conceal or destroy an existing identity/data set on failed proof.
    return { user, recovered, setupRequired: true };
  }
}

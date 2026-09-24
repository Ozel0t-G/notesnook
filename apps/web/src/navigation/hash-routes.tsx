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

import { hashNavigate, navigate } from ".";
import { defineHashRoutes } from "./types";
import {
  AddNotebookDialog,
  EditNotebookDialog
} from "../dialogs/add-notebook-dialog";
import { EmailVerificationDialog } from "../dialogs/email-verification-dialog";
import { SettingsDialog } from "../dialogs/settings";
import { BuyDialog } from "../dialogs/buy-dialog";
import {
  AddReminderDialog,
  EditReminderDialog
} from "../dialogs/add-reminder-dialog";
import { FeatureDialog } from "../dialogs/feature-dialog";
import { CreateTagDialog } from "../dialogs/item-dialog";
import { OnboardingDialog } from "../dialogs/onboarding-dialog";
import { isSectionKey, SectionKeys } from "../dialogs/settings/types";
import { TaskDialog } from "../dialogs/task-dialog";
import { taskDomain } from "../common/task-domain";
import { showToast } from "../utils/toast";
import { logger } from "../utils/logger";
import { strings } from "@notesnook/intl";

const hashroutes = defineHashRoutes({
  "/": () => {},
  "/email/verify": () => {
    EmailVerificationDialog.show({}).then(afterAction);
  },
  "/notebooks/create": () => {
    AddNotebookDialog.show({}).then(afterAction);
  },
  "/notebooks/:notebookId/edit": ({ notebookId }) => {
    EditNotebookDialog.show({ notebookId })?.then(afterAction);
  },
  "/reminders/create": () => {
    if (IS_DESKTOP_APP) void showTaskCreate();
    else AddReminderDialog.show({}).then(afterAction);
  },
  "/reminders/:reminderId/edit": ({ reminderId }) => {
    if (IS_DESKTOP_APP) void showMigratedTask(reminderId);
    else EditReminderDialog.show({ reminderId }).then(afterAction);
  },
  "/tasks/create": () => {
    void showTaskCreate();
  },
  "/tasks/:taskId/edit": ({ taskId }) => {
    void (async () => {
      try {
        navigate("/tasks", { replace: true, notify: true });
        const [task, lists] = await Promise.all([
          taskDomain.tasks.get(taskId),
          taskDomain.taskLists.list()
        ]);
        if (task) await TaskDialog.show({ task, lists });
        else showToast("error", strings.noResultsFound());
      } catch (error) {
        logger.error(error);
        showToast("error", strings.tasksCouldNotLoad());
      } finally {
        afterTaskAction();
      }
    })();
  },
  "/tags/create": () => {
    CreateTagDialog.show().then(afterAction);
  },
  "/buy": () => {
    BuyDialog.show({}).then(afterAction);
  },
  "/buy/:code": ({ code }: { code: string }) => {
    BuyDialog.show({ couponCode: code }).then(afterAction);
  },
  "/welcome": () => {
    OnboardingDialog.show({})?.then(afterAction);
  },
  "/confirmed": () => {
    FeatureDialog.show({ featureName: "confirmed" }).then(afterAction);
  },
  "/settings": () => {
    SettingsDialog.show({}).then(afterAction);
  },
  "/settings/:section": ({ section }) => {
    SettingsDialog.show(
      isSectionKey(section) ? { activeSection: section as SectionKeys } : {}
    ).then(afterAction);
  }
});

export default hashroutes;
export type HashRoute = keyof typeof hashroutes;

function afterAction() {
  hashNavigate("/", { replace: true, notify: false });
  if (!history.state.replace) history.back();
}

function afterTaskAction() {
  hashNavigate("/", { replace: true, notify: false });
  navigate("/tasks", { replace: true, notify: true });
}

async function showTaskCreate() {
  try {
    navigate("/tasks", { replace: true, notify: true });
    const lists = await taskDomain.taskLists.list();
    await TaskDialog.show({ lists });
  } catch (error) {
    logger.error(error);
    showToast("error", strings.tasksCouldNotLoad());
  } finally {
    afterTaskAction();
  }
}

async function showMigratedTask(reminderId: string) {
  try {
    navigate("/tasks", { replace: true, notify: true });
    const [tasks, lists] = await Promise.all([
      taskDomain.tasks.list(),
      taskDomain.taskLists.list()
    ]);
    const task = tasks.find((item) => item.legacyReminderId === reminderId);
    if (task) await TaskDialog.show({ task, lists });
    else showToast("error", strings.noResultsFound());
  } catch (error) {
    logger.error(error);
    showToast("error", strings.tasksCouldNotLoad());
  } finally {
    afterTaskAction();
  }
}

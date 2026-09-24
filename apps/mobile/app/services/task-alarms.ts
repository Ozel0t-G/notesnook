import type { Task } from "@notesnook/core";
import { NativeModules, Platform } from "react-native";
import { useUserStore } from "../stores/use-user-store";
import { desiredTaskAlarms } from "./task-alarm-plan";

export type UrgentAlarmStatus =
  | "unsupported"
  | "notDetermined"
  | "denied"
  | "authorized";

type ReplaceResult = {
  status: UrgentAlarmStatus;
  failedTaskIds: string[];
};

type TaskAlarmNative = {
  status(): Promise<UrgentAlarmStatus>;
  requestAuthorization(): Promise<UrgentAlarmStatus>;
  replaceAlarms(
    accountId: string,
    alarms: ReturnType<typeof desiredTaskAlarms>
  ): Promise<ReplaceResult>;
  cancelAll(): Promise<void>;
};

const Native: TaskAlarmNative | undefined =
  Platform.OS === "ios" ? NativeModules.TaskAlarmModule : undefined;

export async function urgentStatus(): Promise<UrgentAlarmStatus> {
  if (!Native) return "unsupported";
  return Native.status();
}

/** Call from the Urgent switch, never as part of background reconciliation. */
export async function requestUrgentPermission(): Promise<UrgentAlarmStatus> {
  if (!Native) return "unsupported";
  return Native.requestAuthorization();
}

export async function reconcileTaskAlarms(
  tasks: Task[],
  privacyHidden: boolean
): Promise<ReplaceResult> {
  const desired = desiredTaskAlarms(tasks, privacyHidden);
  if (!Native)
    return {
      status: "unsupported",
      failedTaskIds: desired.map((alarm) => alarm.taskId)
    };
  const accountId = useUserStore.getState().user?.id || "local";
  return Native.replaceAlarms(accountId, desired);
}

export async function cancelAllTaskAlarms() {
  await Native?.cancelAll();
}

import { execFileSync } from "node:child_process";
import { by, device, system } from "detox";

const UDID = process.env.VEYRAN_QA_DEVICE_ID as string;
const OUT = "/Users/ozel0t/Notesnook/qa/widget-repro";
const MODE = process.env.WIDGET_QA_MODE || "background";
const LABEL = process.env.WIDGET_QA_LABEL || "Complete Urgent Alarm";
const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8" });
const shot = (name: string) =>
  sh("xcrun", ["simctl", "io", UDID, "screenshot", `${OUT}/${name}.png`]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const group = () =>
  sh("xcrun", [
    "simctl",
    "get_app_container",
    UDID,
    "com.ozel0t.note.notesnookpencil",
    "group.com.ozel0t.note.notesnookpencil"
  ]).trim();
const queue = () => {
  try {
    return sh("ls", ["-la", `${group()}/task-widget-actions-v1`]);
  } catch {
    return "(no queue dir)";
  }
};
const snapshotTasks = () => {
  try {
    const raw = sh("cat", [`${group()}/reminder-widget-snapshot.json`]);
    const json = JSON.parse(raw);
    return JSON.stringify({
      count: json.count,
      tasks: json.tasks.map((t: any) => `${t.id}:${t.updatedAt}:${t.title}`)
    });
  } catch (e) {
    return "(no snapshot) " + e;
  }
};

describe("TASKS WIDGET TAP", () => {
  it("taps the completion ring on the home screen", async () => {
    await device.launchApp({
      newInstance: true,
      launchArgs: { detoxEnableSynchronization: 0 }
    });
    await device.disableSynchronization();
    await sleep(9000);
    await device.sendToHome();
    await sleep(2500);
    if (MODE === "terminated") {
      sh("xcrun", [
        "simctl",
        "terminate",
        UDID,
        "com.ozel0t.note.notesnookpencil"
      ]);
      await sleep(2000);
    } else {
      await sleep(6000);
    }
    shot("20-before-tap");
    console.log("BEFORE queue:\n" + queue());
    console.log("BEFORE snapshot: " + snapshotTasks());
    await system.element(by.system.label(LABEL)).tap();
    console.log("TAPPED " + LABEL + " at " + new Date().toISOString());
    for (const [i, wait] of [1500, 2500, 4000, 6000, 8000, 12000].entries()) {
      await sleep(wait);
      shot(`21-after-tap-${i}`);
      console.log(`AFTER[${i}] ${new Date().toISOString()} queue:\n` + queue());
      console.log(`AFTER[${i}] snapshot: ` + snapshotTasks());
    }
  }, 300000);
});

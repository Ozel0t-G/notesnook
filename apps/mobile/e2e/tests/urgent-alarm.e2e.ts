import { execFileSync } from "node:child_process";
import { by, device, element, system, waitFor } from "detox";

const UDID = process.env.VEYRAN_QA_DEVICE_ID as string;
const OUT = "/Users/ozel0t/Notesnook/qa/sim-shots";
const shot = (name: string) =>
  execFileSync("xcrun", [
    "simctl",
    "io",
    UDID,
    "screenshot",
    `${OUT}/${name}.png`
  ]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tapText = async (text: string, timeout = 15000) => {
  const el = element(by.text(text)).atIndex(0);
  await waitFor(el).toBeVisible().withTimeout(timeout);
  await el.tap();
};

describe("URGENT ALARM", () => {
  it("creates an urgent task and captures the alarm", async () => {
    await device.launchApp({
      newInstance: true,
      launchArgs: { detoxEnableSynchronization: 0 }
    });
    await device.disableSynchronization();
    await sleep(4000);
    shot("09-launch");
    await tapText("Continue", 4000).catch(() => undefined);
    await sleep(2500);
    shot("10-after-continue");
    await element(by.id("veyran-tab-tasks")).tap();
    await sleep(2000);
    shot("11-tasks");
    await tapText("Reminders");
    await sleep(1500);
    shot("11b-list");
    await element(by.id("task-new-row")).tap();
    await element(by.id("task-quick-add-input")).typeText("Urgent Alarm\n");
    await sleep(1500);
    shot("12-task-added");
    await element(by.label("Details")).atIndex(0).tap();
    await sleep(1500);
    shot("13-details");
    await element(by.label("Date")).atIndex(0).tap();
    await sleep(800);
    await element(by.label("Time")).atIndex(0).tap();
    await sleep(800);
    shot("14-date-time");
    const target = new Date(Date.now() + 3 * 60 * 1000);
    target.setSeconds(0, 0);
    await element(by.type("UIDatePicker"))
      .atIndex(0)
      .setDatePickerDate(target.toISOString(), "ISO8601");
    await sleep(800);
    await element(by.label("Urgent")).atIndex(0).tap();
    await sleep(2000);
    shot("15-urgent");
    await system.element(by.system.label("Allow")).tap();
    await sleep(1500);
    shot("16-allowed");
    await element(by.label("Done")).atIndex(0).tap();
    await sleep(1500);
    shot("17-saved");
    await device.sendToHome();
    await sleep(Math.max(0, target.getTime() + 3000 - Date.now()));
    shot("20-alarm-fired");
    await sleep(8000);
    shot("21-alarm-fired-8s");
    try {
      await system.element(by.system.label("Snooze")).tap();
      await sleep(3000);
      shot("22-after-snooze");
    } catch (e) {
      shot("22-snooze-not-found");
    }
  }, 600000);
});

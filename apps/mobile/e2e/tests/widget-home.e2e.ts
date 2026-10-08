import { execFileSync } from "node:child_process";
import { device } from "detox";

const UDID = process.env.VEYRAN_QA_DEVICE_ID as string;
const OUT = "/Users/ozel0t/Notesnook/qa/widget-repro";
const shot = (name: string) =>
  execFileSync("xcrun", [
    "simctl",
    "io",
    UDID,
    "screenshot",
    `${OUT}/${name}.png`
  ]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TASKS WIDGET HOME", () => {
  it("explores the home screen", async () => {
    await device.launchApp({
      newInstance: true,
      launchArgs: { detoxEnableSynchronization: 0 }
    });
    await device.disableSynchronization();
    await sleep(6000);
    shot("02-launched");
    await sleep(1500);
    shot("03-after-dialog");
    await device.sendToHome();
    await sleep(2000);
    shot("04-home");
    await device.longPress({ x: 200, y: 700 }, 1800);
    await sleep(2000);
    shot("05-after-longpress");
  }, 300000);
});

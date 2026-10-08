import { execFileSync } from "node:child_process";
import { by, system } from "detox";

const UDID = process.env.VEYRAN_QA_DEVICE_ID as string;
const OUT = "/Users/ozel0t/Notesnook/qa/widget-repro";

describe("DIALOG", () => {
  it("dismisses the open dialogs", async () => {
    for (let i = 0; i < 8; i++) {
      try {
        await system.element(by.system.label("Cancel")).tap();
        console.log("tapped cancel", i);
      } catch (e) {
        console.log("no more dialog", i);
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    execFileSync("xcrun", ["simctl", "io", UDID, "screenshot", `${OUT}/d2.png`]);
  }, 200000);
});

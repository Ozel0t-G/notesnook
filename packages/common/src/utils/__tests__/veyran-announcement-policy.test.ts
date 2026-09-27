import { describe, expect, it } from "vitest";
import { isVeyranAnnouncementAllowed } from "../veyran-announcement-policy.js";

describe("VeyraN announcement policy", () => {
  it.each([
    { id: "legacy", body: [{ text: "Upgrade to Notesnook Pro" }] },
    { id: "legacy", callToActions: [{ type: "promo", title: "Subscribe" }] },
    { id: "legacy", body: [{ text: "Streetwriters support" }] },
    { id: "legacy", userTypes: ["trial"] }
  ])("filters upstream or paid-plan content", (announcement) => {
    expect(isVeyranAnnouncementAllowed(announcement)).toBe(false);
  });

  it("keeps ordinary VeyraN notices", () => {
    expect(
      isVeyranAnnouncementAllowed({
        id: "service-notice",
        body: [{ text: "VeyraN maintenance tonight" }]
      })
    ).toBe(true);
  });

  it("rejects malformed remote data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isVeyranAnnouncementAllowed(null)).toBe(false);
    expect(isVeyranAnnouncementAllowed(circular)).toBe(false);
  });
});

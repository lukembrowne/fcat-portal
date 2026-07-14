import { describe, it, expect } from "vitest";
import { buildWhatsappReplyLink } from "@/lib/landowner/phone";

describe("buildWhatsappReplyLink", () => {
  it("builds a link from an international +593 number", () => {
    expect(buildWhatsappReplyLink("+593 99 999 9999")).toBe(
      "https://wa.me/593999999999",
    );
  });

  it("normalizes a local 0-prefixed 10-digit number to +593", () => {
    expect(buildWhatsappReplyLink("0999999999")).toBe(
      "https://wa.me/593999999999",
    );
  });

  it("strips punctuation and spaces", () => {
    expect(buildWhatsappReplyLink("(09) 9999-9999")).toBe(
      "https://wa.me/593999999999",
    );
  });

  it("returns null when there are no digits", () => {
    expect(buildWhatsappReplyLink("")).toBeNull();
    expect(buildWhatsappReplyLink("sin número")).toBeNull();
  });
});

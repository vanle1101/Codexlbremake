import { describe, expect, it } from "vitest";

import i18n, { normalizeSupportedLanguage } from "@/i18n";

describe("normalizeSupportedLanguage", () => {
  it("keeps exact supported locales", () => {
    expect(normalizeSupportedLanguage("vi")).toBe("vi");
    expect(normalizeSupportedLanguage("en")).toBe("en");
  });

  it("normalizes detected regional locales to supported toggle values", () => {
    expect(normalizeSupportedLanguage("vi-VN")).toBe("vi");
    expect(normalizeSupportedLanguage("en-US")).toBe("en");
    expect(normalizeSupportedLanguage("en-GB")).toBe("en");
  });

  it("falls back to Vietnamese for missing or unsupported locales", () => {
    expect(normalizeSupportedLanguage(undefined)).toBe("vi");
    expect(normalizeSupportedLanguage("fr-FR")).toBe("vi");
  });

  it("keeps normalized Vietnamese detections on the supported vi resource", async () => {
    await i18n.changeLanguage(normalizeSupportedLanguage("vi-VN"));

    expect(i18n.resolvedLanguage).toBe("vi");
  });
});

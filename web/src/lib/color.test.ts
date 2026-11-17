import { describe, expect, it } from "vitest";
import { colorFromHex, hexToHsv, hsvToHex, isValidHex, suggestDomainColor } from "./color";

describe("颜色工具", () => {
  it("校验并转换 HEX", () => {
    expect(isValidHex("#0285ff")).toBe(true);
    expect(isValidHex("#fff")).toBe(false);
    expect(colorFromHex("#ffffff").ink).toBe("#101828");
    expect(colorFromHex("#000000").ink).toBe("#ffffff");
    const hsv = hexToHsv("#3b82f6");
    expect(hsvToHex(hsv).toLowerCase()).toBe("#3b82f6");
  });

  it("新增业务域选择最大色差空档", () => {
    const first = suggestDomainColor([]);
    expect(isValidHex(first)).toBe(true);
    const second = suggestDomainColor([first]);
    expect(second).not.toBe(first);
    expect(isValidHex(second)).toBe(true);
    const third = suggestDomainColor([first, second]);
    expect([first, second]).not.toContain(third);
  });
});

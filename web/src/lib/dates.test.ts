import { describe, expect, it } from "vitest";
import { addDays, countDays, enumerateDates, finishDate, isWorkday, isValidDate, shiftWorkday } from "./dates";
import { calendar } from "../test/fixtures";

describe("日期与工作日", () => {
  it("识别 2026 法定假日与调休", () => {
    expect(isWorkday("2026-01-01", calendar)).toBe(false);
    expect(isWorkday("2026-01-04", calendar)).toBe(true);
    expect(isWorkday("2026-02-14", calendar)).toBe(true);
    expect(isWorkday("2026-02-17", calendar)).toBe(false);
    expect(isWorkday("2026-11-16", calendar)).toBe(true);
    expect(isWorkday("2026-11-21", calendar)).toBe(false);
  });

  it("统计工作日并支持休假日历", () => {
    expect(countDays("2026-01-01", "2026-01-11", calendar)).toBe(6);
    expect(countDays("2026-01-01", "2026-01-11", calendar, { vacation: ["2026-01-05", "2026-01-06"] })).toBe(4);
    expect(countDays("2026-11-21", "2026-11-22", calendar)).toBe(0);
    expect(countDays("2026-11-21", "2026-11-22", calendar, { overtime: ["2026-11-21"] })).toBe(1);
  });

  it("从起始日推算交付日并跳过休假", () => {
    expect(finishDate("2026-01-01", 3, calendar)).toBe("2026-01-06");
    expect(finishDate("2026-11-16", 2, calendar, { vacation: ["2026-11-16"] })).toBe("2026-11-18");
    expect(finishDate("", 3, calendar)).toBe("");
  });

  it("日期运算与合法性", () => {
    expect(addDays("2026-11-16", 5)).toBe("2026-11-21");
    expect(addDays("2026-11-16", -3)).toBe("2026-11-13");
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-11-16")).toBe(true);
    expect(enumerateDates("2026-11-16", "2026-11-18")).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(shiftWorkday("2026-11-16", 3, calendar)).toBe("2026-11-19");
  });
});

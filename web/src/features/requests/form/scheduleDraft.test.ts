import { describe, expect, it } from "vitest";
import { calendar, request } from "../../../test/fixtures";
import {
  addSegment,
  changeDays,
  changeDelivery,
  changeSegmentEdge,
  changeStart,
  deliveryDisplay,
  holdFlagsOf,
  normalizeForSubmit,
  planOfDraft,
  removeSegmentAt,
  splitInitial,
  toggleHold,
} from "./scheduleDraft";

describe("表单排期适配（不复制排期算法）", () => {
  it("打开/普通编辑不改变已存排期：休息日交付、休假标记、人天均保持", () => {
    const draft = request({ start: "2026-12-04", delivery: "2026-12-05", days: 1, vacation: ["2026-12-04"], segments: [] });
    const result = normalizeForSubmit(draft, calendar);
    expect(result.error).toBe("");
    expect(result.draft.start).toBe("2026-12-04");
    expect(result.draft.delivery).toBe("2026-12-05");
    expect(result.draft.days).toBe(1);
    expect(result.draft.vacation).toEqual(["2026-12-04"]);
    expect(result.draft.segments).toEqual([]);
  });

  it("多段交付取最后一段 end，并保留 holdBefore", () => {
    const draft = request({
      days: 4,
      start: "2026-12-07",
      delivery: "2026-12-12",
      segments: [
        { start: "2026-12-07", end: "2026-12-08", holdBefore: false },
        { start: "2026-12-10", end: "2026-12-12", holdBefore: true },
      ],
    });
    expect(deliveryDisplay(draft)).toBe("2026-12-12");
    const result = normalizeForSubmit(draft, calendar);
    expect(result.error).toBe("");
    expect(result.draft.delivery).toBe("2026-12-12");
    expect(result.draft.segments[1]).toEqual({ start: "2026-12-10", end: "2026-12-12", holdBefore: true });
    expect(holdFlagsOf(result.draft)).toEqual([false, true]);
  });

  it("修改人天/日期通过 schedule 操作并保留 HOLD 开关", () => {
    const draft = request({
      days: 4,
      start: "2026-12-07",
      delivery: "2026-12-11",
      segments: [
        { start: "2026-12-07", end: "2026-12-08", holdBefore: false },
        { start: "2026-12-10", end: "2026-12-11", holdBefore: true },
      ],
    });
    const extended = changeDays(draft, calendar, 5);
    expect(extended.error).toBe("");
    expect(extended.draft.days).toBe(5);
    expect(extended.draft.segments[1]!.holdBefore).toBe(true);
    expect(extended.draft.delivery).toBe("2026-12-14");

    const movedStart = changeStart(draft, calendar, "2026-12-08");
    expect(movedStart.error).toBe("");
    expect(movedStart.draft.start).toBe("2026-12-08");
    expect(movedStart.draft.segments[1]!.holdBefore).toBe(true);

    const delivery = changeDelivery(draft, calendar, "2026-12-14");
    expect(delivery.error).toBe("");
    expect(delivery.draft.delivery).toBe("2026-12-14");
    expect(delivery.draft.segments[1]!.holdBefore).toBe(true);
  });

  it("拉伸段边界、增加/删除段保持显式 HOLD", () => {
    const draft = request({
      days: 4,
      start: "2026-12-07",
      delivery: "2026-12-11",
      segments: [
        { start: "2026-12-07", end: "2026-12-08", holdBefore: false },
        { start: "2026-12-10", end: "2026-12-11", holdBefore: true },
      ],
    });
    const resized = changeSegmentEdge(draft, calendar, 0, "end", "2026-12-09");
    expect(resized.error).toBe("");
    expect(resized.draft.segments[0]!.end).toBe("2026-12-09");
    expect(resized.draft.segments[1]!.holdBefore).toBe(true);

    const added = addSegment(draft, calendar);
    expect(added.error).toBe("");
    expect(added.draft.segments.length).toBe(3);
    expect(added.draft.segments[1]!.holdBefore).toBe(true);
    expect(added.draft.segments[2]!.holdBefore).toBe(false);

    const removed = removeSegmentAt(draft, calendar, 0);
    expect(removed.error).toBe("");
    expect(removed.draft.segments.length).toBe(1);
    expect(removed.draft.segments[0]!.holdBefore).toBe(false);

    const split = splitInitial(request({ start: "2026-12-07", delivery: "2026-12-09", days: 3, segments: [] }), calendar);
    expect(split.error).toBe("");
    expect(split.draft.segments.length).toBe(2);
    expect(split.draft.segments.every((segment) => segment.holdBefore === false)).toBe(true);
  });

  it("切换 HOLD 与空排期保护", () => {
    const draft = request({ segments: [{ start: "2026-12-07", end: "2026-12-08", holdBefore: false }, { start: "2026-12-10", end: "2026-12-11", holdBefore: false }] });
    expect(toggleHold(draft, 1, true).segments[1]!.holdBefore).toBe(true);
    const plan = planOfDraft(draft);
    expect(plan.segments).toHaveLength(2);
    expect(plan.vacation).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { calendar, request, users } from "../../../test/fixtures";
import { normalizeForSubmit } from "../form/scheduleDraft";
import { enumerateDates } from "../../../lib/dates";
import {
  admissionSortOrderForRows,
  buildSequencePlan,
  currentLivePhase,
  dayInfo,
  estimateCenters,
  extendLastSegment,
  groupRequests,
  holdLayout,
  moveSegmentDates,
  planOf,
  removeSegment,
  resizeSegmentDates,
  segmentFillBounds,
  shiftSchedule,
  supplementRequest,
  workingHoldGaps,
} from "./ganttMath";

describe("当前开发段动效", () => {
  it("当天有效排期支持待开发与开发中，完成和暂停保持静态", () => {
    for (const status of ["待开发", "开发中"] as const) {
      expect(currentLivePhase(request({ status }), "2026-11-18", calendar)).toBe(0);
    }
    for (const status of ["待评审", "HOLD", "已完成"] as const) {
      expect(currentLivePhase(request({ status }), "2026-11-18", calendar)).toBe(-1);
    }
    expect(currentLivePhase(request({ developer: "" }), "2026-11-18", calendar)).toBe(-1);
    expect(currentLivePhase(request({ archived: true }), "2026-11-18", calendar)).toBe(-1);
    expect(currentLivePhase(request({ vacation: ["2026-11-18"] }), "2026-11-18", calendar)).toBe(-1);
    expect(currentLivePhase(request({ start: "2026-11-16", delivery: "2026-11-22" }), "2026-11-22", calendar)).toBe(-1);
  });

  it("HOLD 间隔不播放，只在当日所在段显示", () => {
    const row = request({ start: "2026-11-12", delivery: "2026-11-20", segments: [{ start: "2026-11-12", end: "2026-11-13", holdBefore: false }, { start: "2026-11-19", end: "2026-11-20", holdBefore: true }] });
    expect(currentLivePhase(row, "2026-11-18", calendar)).toBe(-1);
    expect(currentLivePhase(row, "2026-11-19", calendar)).toBe(1);
  });
});

const twoSegments = request({
  id: 10,
  name: "多段需求",
  days: 4,
  start: "2026-11-16",
  delivery: "2026-11-24",
  segments: [
    { start: "2026-11-16", end: "2026-11-17", holdBefore: false },
    { start: "2026-11-23", end: "2026-11-24", holdBefore: true },
  ],
});

describe("甘特排期纯计算", () => {
  it("单段从准入/交付构造排期", () => {
    const plan = planOf(request({ id: 1, start: "2026-11-16", delivery: "2026-11-18", days: 3 }), calendar);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toEqual({ start: "2026-11-16", end: "2026-11-18", holdBefore: false, index: 0 });
    expect(plan.delivery).toBe("2026-11-18");
  });

  it("只有起始日时按人天推导交付（含待估 3 天占位）", () => {
    expect(planOf(request({ start: "2026-11-16", delivery: "", days: 2 }), calendar).delivery).toBe("2026-11-17");
    expect(planOf(request({ start: "2026-11-16", delivery: "", days: 0 }), calendar).delivery).toBe("2026-11-18");
  });

  it("HOLD 只存在于含工作日的间隔", () => {
    expect(workingHoldGaps(twoSegments, calendar)).toHaveLength(1);
    expect(workingHoldGaps(twoSegments, calendar)[0]).toMatchObject({ afterIndex: 1, start: "2026-11-18", end: "2026-11-22" });
    const weekendGap = request({
      segments: [
        { start: "2026-11-20", end: "2026-11-20", holdBefore: false },
        { start: "2026-11-23", end: "2026-11-23", holdBefore: true },
      ],
    });
    expect(workingHoldGaps(weekendGap, calendar)).toHaveLength(0);
    const holdRow = { ...twoSegments, status: "HOLD" as const };
    expect(dayInfo(holdRow, "2026-11-19", calendar).hold).toBe(true);
    expect(dayInfo({ ...twoSegments, status: "待开发" }, "2026-11-19", calendar).hold).toBe(true);
    expect(dayInfo({ ...twoSegments, segments: twoSegments.segments.map((segment, index) => (index ? { ...segment, holdBefore: false } : segment)) }, "2026-11-19", calendar).hold).toBe(false);
    expect(holdLayout(holdRow, ["2026-11-19"], calendar).get("2026-11-19")).toEqual({ centerOffset: null });
    expect(holdLayout(weekendGap, enumerateDates("2026-11-20", "2026-11-23"), calendar).size).toBe(0);
  });

  it("HOLD 居中于完整日历间隔，偶数天落在两格交界，连线经过周末", () => {
    const odd = holdLayout(twoSegments, enumerateDates("2026-11-16", "2026-11-24"), calendar);
    expect([...odd.keys()]).toEqual(enumerateDates("2026-11-18", "2026-11-22"));
    expect([...odd].filter(([, cell]) => cell.centerOffset !== null)).toEqual([["2026-11-20", { centerOffset: 0 }]]);
    const evenRow = request({
      segments: [
        { start: "2026-11-16", end: "2026-11-17", holdBefore: false },
        { start: "2026-11-20", end: "2026-11-20", holdBefore: true },
      ],
    });
    const even = holdLayout(evenRow, enumerateDates("2026-11-16", "2026-11-20"), calendar);
    expect([...even]).toEqual([["2026-11-18", { centerOffset: 0.5 }], ["2026-11-19", { centerOffset: null }]]);
    expect(holdLayout({ ...evenRow, segments: evenRow.segments.map((segment) => ({ ...segment, holdBefore: false })) }, [...even.keys()], calendar).size).toBe(0);
  });

  it("HOLD 中点不因横向虚拟化或休假而跳动，也不会凭空补到可见区域", () => {
    const row = { ...twoSegments, vacation: ["2026-11-20"] };
    const full = holdLayout(row, enumerateDates("2026-11-16", "2026-11-24"), calendar);
    const clipped = holdLayout(row, ["2026-11-20", "2026-11-21", "2026-11-22"], calendar);
    expect([...clipped]).toEqual([...full].filter(([date]) => date >= "2026-11-20"));
    const afterCenter = holdLayout(row, ["2026-11-21", "2026-11-22"], calendar);
    expect([...afterCenter.values()].every((cell) => cell.centerOffset === null)).toBe(true);
  });

  it("休假与加班标记", () => {
    const row = request({ start: "2026-11-16", delivery: "2026-11-22", vacation: ["2026-11-17"], overtime: ["2026-11-21"] });
    expect(dayInfo(row, "2026-11-17", calendar).dayType).toBe("leave");
    expect(dayInfo(row, "2026-11-17", calendar).active).toBe(false);
    expect(dayInfo(row, "2026-11-21", calendar).overtime).toBe(true);
    expect(dayInfo(row, "2026-11-21", calendar).mark).toBe("overtime");
    expect(dayInfo(row, "2026-11-22", calendar).active).toBe(false);
  });

  it("独立加班标记覆盖段外、未排期和 HOLD 空档，但不凭空生成排期", () => {
    for (const row of [
      request({ start: "2026-11-16", delivery: "2026-11-18", overtime: ["2026-11-14", "2026-11-21"] }),
      request({ start: "", delivery: "", overtime: ["2026-11-21"] }),
      { ...twoSegments, overtime: ["2026-11-21"] },
    ]) {
      expect(dayInfo(row, "2026-11-21", calendar)).toMatchObject({
        phaseIndex: -1, inSegment: false, active: false, overtime: true, dayType: "overtime", mark: "overtime", visible: true,
      });
      expect(dayInfo({ ...row, overtime: [] }, "2026-11-21", calendar)).toMatchObject({ overtime: false, dayType: "", mark: "", visible: false });
    }
    expect(dayInfo(request({ overtime: ["2026-11-14"] }), "2026-11-14", calendar)).toMatchObject({ overtime: true, active: false });
    expect(dayInfo(request({ overtime: ["2026-11-17"] }), "2026-11-17", calendar)).toMatchObject({ overtime: false, active: true, dayType: "" });
  });

  it.each([
    { name: "首端周日", start: "2026-11-22", end: "2026-11-24", expected: { start: "2026-11-23", end: "2026-11-24" } },
    { name: "末端周末", start: "2026-11-20", end: "2026-11-22", expected: { start: "2026-11-20", end: "2026-11-20" } },
    { name: "首端加班与内部周日", start: "2026-11-21", end: "2026-11-24", overtime: ["2026-11-21"], expected: { start: "2026-11-21", end: "2026-11-24" } },
    { name: "末端加班", start: "2026-11-20", end: "2026-11-22", overtime: ["2026-11-22"], expected: { start: "2026-11-20", end: "2026-11-22" } },
    { name: "整段休息", start: "2026-11-21", end: "2026-11-22", expected: null },
    { name: "首尾休假", start: "2026-11-16", end: "2026-11-20", vacation: ["2026-11-16", "2026-11-18", "2026-11-20"], expected: { start: "2026-11-17", end: "2026-11-19" } },
    { name: "整段休假", start: "2026-11-16", end: "2026-11-17", vacation: ["2026-11-16", "2026-11-17"], expected: null },
    { name: "法定假期", start: "2027-02-05", end: "2027-02-15", expected: { start: "2027-02-14", end: "2027-02-15" } },
  ])("填充仅连接段内首末开发日：$name，原日期和标记不变", ({ start, end, overtime = [], vacation = [], expected }) => {
    const row = request({ start, delivery: end, overtime, vacation, segments: [{ start, end, holdBefore: false }] });
    const before = structuredClone(row);
    expect(segmentFillBounds(row, calendar)).toEqual([expected]);
    expect(row).toEqual(before);
  });

  it("各段独立计算填充，不跨 HOLD 连接，无排期不生成色条", () => {
    const row = request({ segments: [
      { start: "2026-11-20", end: "2026-11-22", holdBefore: false },
      { start: "2026-11-28", end: "2026-12-01", holdBefore: true },
    ] });
    expect(segmentFillBounds(row, calendar)).toEqual([
      { start: "2026-11-20", end: "2026-11-20" },
      { start: "2026-11-30", end: "2026-12-01" },
    ]);
    expect(segmentFillBounds(request({ start: "", delivery: "" }), calendar)).toEqual([]);
  });

  it("待估图标只在段中间显示一次", () => {
    const row = request({ start: "2026-11-16", delivery: "2026-11-20", days: 0 });
    const centers = estimateCenters(row, ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"], calendar);
    expect(centers.size).toBe(1);
  });

  it("补排期合并相邻/可桥接片段，工作日空档另起一段", () => {
    const base = request({ start: "2026-11-16", delivery: "2026-11-17", days: 2, segments: [] });
    const merged = supplementRequest(base, ["2026-11-18", "2026-11-19", "2026-11-20"], calendar).request;
    expect(merged.segments).toHaveLength(1);
    expect(merged.segments[0]).toEqual({ start: "2026-11-16", end: "2026-11-20", holdBefore: false });
    expect(merged.days).toBe(5);
    const split = supplementRequest({ ...base, segments: [{ start: "2026-11-16", end: "2026-11-17", holdBefore: false }] }, ["2026-11-24"], calendar).request;
    expect(split.segments).toHaveLength(2);
    expect(split.segments[1]).toEqual({ start: "2026-11-24", end: "2026-11-24", holdBefore: false });
  });

  it("删除段保留其他段并清理被删段内标记", () => {
    const row = { ...twoSegments, vacation: ["2026-11-17", "2026-11-24"], overtime: [] };
    const next = removeSegment(row, 0, calendar);
    expect(next.segments).toHaveLength(1);
    expect(next.segments[0]).toEqual({ start: "2026-11-23", end: "2026-11-24", holdBefore: false });
    expect(next.start).toBe("2026-11-23");
    expect(next.delivery).toBe("2026-11-24");
    expect(next.vacation).toEqual(["2026-11-24"]);
    const empty = removeSegment(row, 0, calendar);
    const cleared = removeSegment(empty, 0, calendar);
    expect(cleared.segments).toHaveLength(0);
    expect(cleared.start).toBe("");
    expect(cleared.delivery).toBe("");
    expect(cleared.days).toBe(1);
  });

  it("延长最后一段与移动单段", () => {
    const extended = extendLastSegment(twoSegments, "2026-11-26", calendar);
    expect(extended.segments[1]).toEqual({ start: "2026-11-23", end: "2026-11-26", holdBefore: true });
    expect(extended.delivery).toBe("2026-11-26");
    const moved = moveSegmentDates(twoSegments, 1, "2026-11-30", calendar);
    expect(moved?.segments[1]?.start).toBe("2026-11-30");
    expect(moveSegmentDates(twoSegments, 1, "2026-11-16", calendar)).toBeNull();
  });

  it("拉伸段不越过相邻段", () => {
    const stretched = resizeSegmentDates(twoSegments, 0, "end", "2026-11-25", calendar);
    expect(stretched?.segments[0]?.end).toBe("2026-11-20");
    const shrunk = resizeSegmentDates(twoSegments, 0, "end", "2026-11-16", calendar);
    expect(shrunk?.segments[0]?.end).toBe("2026-11-16");
    expect(resizeSegmentDates(twoSegments, 0, "start", "2026-11-30", calendar)).not.toBeNull();
  });

  it("已删除账号仍保留历史需求分组与原用户名", () => {
    const deletedUsers = [
      ...users,
      { id: "u3", username: "陈雨", role: "collaborator" as const, disabled: false, deleted: true, avatar: "" },
    ];
    const rows = [request({ id: 20, developer: "u3", name: "已删除账号的需求" })];
    const groups = groupRequests(rows, deletedUsers, calendar, {});
    const group = groups.find((item) => item.developer === "u3");
    expect(group).toBeTruthy();
    expect(group?.name).toBe("陈雨");
    expect(group?.deleted).toBe(true);
    expect(group?.rows.map((row) => row.id)).toEqual([20]);
  });

  it("按开发人分组并支持视图排序", () => {
    const rows = [
      request({ id: 1, developer: "u1", start: "2026-12-01", segments: [{ start: "2026-12-01", end: "2026-12-02", holdBefore: false }] }),
      request({ id: 2, developer: "u1", start: "2026-11-16", segments: [{ start: "2026-11-16", end: "2026-11-17", holdBefore: false }] }),
    ];
    const groups = groupRequests(rows, [], calendar, {});
    expect(groups.find((group) => group.developer === "u1")?.rows.map((row) => row.id)).toEqual([2, 1]);
    const order = admissionSortOrderForRows([rows[0]!, rows[1]!], [1, 2], calendar);
    expect(order).toEqual([2, 1]);
    expect(admissionSortOrderForRows([rows[1]!, rows[0]!], [1, 2], calendar)).toBeNull();
  });

  it("所有需求都保留在对应人员组，未排期在末尾，未分配同样支持排序", () => {
    const rows = [
      request({ id: 10, start: "", delivery: "", developer: "u1" }),
      request({ id: 11, developer: "u1", start: "2026-12-01" }),
      request({ id: 12, developer: "u1" }),
      request({ id: 13, start: "", delivery: "", developer: "" }),
      request({ id: 14, start: "", delivery: "", developer: "u1" }),
      request({ id: 15, developer: "" }),
      request({ id: 16, start: "", delivery: "", developer: "" }),
    ];
    const groups = groupRequests(rows, users, calendar, { u1: [14, 10, 11, 12], "": [16, 13, 15] });
    expect(groups.find((group) => group.developer === "u1")?.rows.map((row) => row.id)).toEqual([11, 12, 14, 10]);
    expect(groups.at(-1)?.name).toBe("-");
    expect(groups.at(-1)?.rows.map((row) => row.id)).toEqual([15, 16, 13]);
    expect(groups.flatMap((group) => group.rows).map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    const defaults = groupRequests([...rows].reverse(), users, calendar, {});
    expect(defaults.find((group) => group.developer === "u1")?.rows.map((row) => row.id)).toEqual([12, 11, 10, 14]);
    expect(defaults.at(-1)?.rows.map((row) => row.id)).toEqual([15, 13, 16]);
  });

  it("顺排平移多段需求时按有效开发日重算并平移休假标记", () => {
    const row = request({
      id: 31,
      name: "带休假的多段需求",
      days: 4,
      start: "2026-12-07",
      delivery: "2026-12-11",
      segments: [
        { start: "2026-12-07", end: "2026-12-08", holdBefore: false },
        { start: "2026-12-10", end: "2026-12-11", holdBefore: true },
      ],
      vacation: ["2026-12-07"],
    });
    const shifted = shiftSchedule(row, "2026-12-08", calendar);
    expect(shifted.start).toBe("2026-12-08");
    expect(shifted.vacation).toEqual(["2026-12-08"]);
    expect(shifted.segments[0]).toEqual({ start: "2026-12-08", end: "2026-12-09", holdBefore: false });
    expect(shifted.segments[1]!.holdBefore).toBe(true);
    expect(shifted.days).toBe(4);
    const normalized = normalizeForSubmit(shifted, calendar);
    expect(normalized.error).toBe("");
    expect(normalized.draft.start).toBe(shifted.start);
    expect(normalized.draft.days).toBe(shifted.days);
  });

  it("顺排预览移动选中块并保留人天", () => {
    const rows = [
      request({ id: 1, developer: "u2", name: "A", start: "2026-11-16", delivery: "2026-11-17", segments: [{ start: "2026-11-16", end: "2026-11-17", holdBefore: false }], days: 2 }),
      request({ id: 2, developer: "u2", name: "B", start: "2026-11-23", delivery: "2026-11-24", segments: [{ start: "2026-11-23", end: "2026-11-24", holdBefore: false }], days: 2 }),
    ];
    const plan = buildSequencePlan(rows, [1, 2], calendar);
    expect(plan.changes).toHaveLength(0);
    const shifted = buildSequencePlan([{ ...rows[0]!, start: "2026-11-20", segments: [{ start: "2026-11-20", end: "2026-11-23", holdBefore: false }] }, rows[1]!], [1, 2], calendar);
    expect(shifted.changes.length).toBeGreaterThan(0);
    expect(shifted.changes.every((change) => change.after.days === change.before.days || change.after.days === 0)).toBe(true);
  });
});

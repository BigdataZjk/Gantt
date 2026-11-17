import { describe, expect, it } from "vitest";
import { calendar, request } from "../../../test/fixtures";
import type { SequencePlan } from "./ganttMath";
import { sequencePreviewRows } from "./sequencePreviewModel";

describe("顺排甘特预览范围", () => {
  it("保留未移动的选中起始项与实际随动项，排除无关需求，日期不额外扩展", () => {
    const anchor = request({ id: 1 });
    const moved = request({ id: 2, start: "2026-11-17", delivery: "2026-11-19" });
    const following = request({ id: 3, start: "2026-11-18", delivery: "2026-11-20" });
    const unrelated = request({ id: 4, start: "2027-06-01", delivery: "2027-06-03" });
    const plan: SequencePlan = {
      ids: [1, 2], selectedCount: 2, warnings: [],
      changes: [
        { before: moved, after: { ...moved, start: "2026-11-19", delivery: "2026-11-23" }, selected: true },
        { before: following, after: { ...following, start: "2026-11-20", delivery: "2026-11-24" }, selected: false },
      ],
    };
    const model = sequencePreviewRows([anchor, moved, following, unrelated], plan, calendar);
    expect(model.rows.map(({ after, selected, changed }) => [after.id, selected, changed])).toEqual([[1, true, false], [2, true, true], [3, false, true]]);
    expect(model).toMatchObject({ start: "2026-11-16", end: "2026-11-24", days: 9 });
    expect(model.rows[1]!.before).toEqual(moved);
    expect(model.rows[1]!.after.start).toBe("2026-11-19");
  });

  it("多段 HOLD 取真实分段边界，跨年及不同开发人共用精确时间轴", () => {
    const first = request({ id: 1, developer: "u1", start: "2026-12-29", delivery: "2026-12-30" });
    const second = request({
      id: 2, developer: "u2", start: "2026-12-31", delivery: "2027-01-06",
      segments: [{ start: "2026-12-31", end: "2026-12-31", holdBefore: false }, { start: "2027-01-05", end: "2027-01-06", holdBefore: true }],
    });
    expect(sequencePreviewRows([first, second], { ids: [1, 2], selectedCount: 2, changes: [], warnings: [] }, calendar)).toMatchObject({ start: "2026-12-29", end: "2027-01-06", days: 9 });
  });

  it("排期提前时仍覆盖原排期与调整后排期，边界周末不会被额外裁掉", () => {
    const before = request({ start: "2026-11-22", delivery: "2026-11-24" });
    const after = { ...before, start: "2026-11-16", delivery: "2026-11-18" };
    expect(sequencePreviewRows([before], { ids: [1], selectedCount: 1, changes: [{ before, after, selected: true }], warnings: [] }, calendar)).toMatchObject({ start: "2026-11-16", end: "2026-11-24", days: 9 });
  });

  it("未排期与未分配项仍在预览，空排期不生成日期轴", () => {
    const rows = [request({ id: 1, start: "", delivery: "" }), request({ id: 2, start: "", delivery: "", developer: "" })];
    const model = sequencePreviewRows(rows, { ids: [1, 2], selectedCount: 0, changes: [], warnings: [] }, calendar);
    expect(model.rows).toHaveLength(2);
    expect(model).toMatchObject({ start: "", end: "", days: 0 });
  });

  it("只有起始日期时按实际人天推导边界，预览不更改原资料", () => {
    const row = request({ delivery: "", days: 2 });
    const original = structuredClone(row);
    expect(sequencePreviewRows([row], { ids: [1], selectedCount: 1, changes: [], warnings: [] }, calendar)).toMatchObject({ start: "2026-11-16", end: "2026-11-17", days: 2 });
    expect(row).toEqual(original);
  });
});

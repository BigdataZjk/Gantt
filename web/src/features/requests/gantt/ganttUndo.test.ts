import { describe, expect, it } from "vitest";
import { calendar, request } from "../../../test/fixtures";
import { isTextUndoTarget, makeUndoStep, restoreUndoStep, scheduleSnapshot } from "./ganttUndo";

describe("个人甘特撤回", () => {
  const before = request({ segments: [{ start: "2026-11-16", end: "2026-11-18", holdBefore: false }] });
  const after = request({ revision: 2, start: "2026-11-17", delivery: "2026-11-19", segments: [{ start: "2026-11-17", end: "2026-11-19", holdBefore: false }] });

  it("恢复排期并保留他人后来修改的名称、备注和最新 revision", () => {
    const step = makeUndoStep([before], [after], calendar);
    const latest = { ...after, revision: 3, name: "后来修改的名称", notes: "另一位同事补充" };
    const restored = restoreUndoStep(step, [latest], calendar)[0]!;
    expect(scheduleSnapshot(restored)).toEqual(scheduleSnapshot(before));
    expect(restored).toMatchObject({ revision: 3, name: latest.name, notes: latest.notes });
  });

  it("连续撤回两步及批量操作只包含自己的排期变更", () => {
    const unrelated = request({ id: 9, name: "同事需求", notes: "保留" });
    const final = { ...after, delivery: "2026-11-20", days: 4, segments: [{ start: "2026-11-17", end: "2026-11-20", holdBefore: false }] };
    const first = makeUndoStep([before], [after, unrelated], calendar);
    const second = makeUndoStep([after], [final, unrelated], calendar);
    const restored = restoreUndoStep(second, [final, unrelated], calendar);
    expect(restoreUndoStep(first, [...restored, unrelated], calendar).map(scheduleSnapshot)).toEqual([scheduleSnapshot(before)]);
    const otherBefore = request({ id: 2 });
    const otherAfter = { ...otherBefore, start: "2026-11-19", delivery: "2026-11-23" };
    const batch = makeUndoStep([before, otherBefore], [after, otherAfter, unrelated], calendar);
    expect(restoreUndoStep(batch, [after, otherAfter, unrelated], calendar).map((row) => row.id)).toEqual([1, 2]);
  });

  it.each(["changed", "deleted", "archived", "calendar"])("冲突 %s 不返回任何可覆盖的数据", (reason) => {
    const step = makeUndoStep([before], [after], calendar);
    const rows = reason === "deleted" ? [] : [{ ...after, ...(reason === "archived" ? { archived: true } : reason === "changed" ? { days: 8 } : {}) }];
    const currentCalendar = reason === "calendar" ? { ...calendar, restDays: [...calendar.restDays, "2026-11-19"] } : calendar;
    expect(() => restoreUndoStep(step, rows, currentCalendar)).toThrow();
  });

  it("排期不变不入栈，仅刷新来源不会触发日历冲突", () => {
    expect(makeUndoStep([before], [{ ...before, notes: "仅备注变更" }], calendar).changes).toEqual([]);
    const step = makeUndoStep([before], [after], calendar);
    expect(restoreUndoStep(step, [after], { ...calendar, source: "刷新来源" })).toHaveLength(1);
  });

  it("普通排期撤回省略补位字段，撤回首次补位时显式清空", () => {
    const ordinaryStep = makeUndoStep([before], [after], calendar);
    const [ordinaryRestore] = restoreUndoStep(ordinaryStep, [after], calendar);
    expect(JSON.parse(JSON.stringify(ordinaryRestore))).not.toHaveProperty("supportSegments");

    const supported = { ...before, supportSegments: [{ requestId: 2, start: "2026-11-19", end: "2026-11-19" }] };
    const supportStep = makeUndoStep([before], [supported], calendar);
    const [supportRestore] = restoreUndoStep(supportStep, [supported], calendar);
    expect(supportRestore?.supportSegments).toEqual([]);
  });

  it("恢复后编辑分段及标记不会污染历史快照", () => {
    const marked = { ...before, vacation: ["2026-11-16"], overtime: ["2026-11-21"] };
    const step = makeUndoStep([marked], [after], calendar);
    marked.vacation.push("2026-11-17");
    const restored = restoreUndoStep(step, [after], calendar)[0]!;
    restored.segments![0]!.start = "2026-11-15";
    restored.vacation!.push("2026-11-18");
    expect(step.changes[0]!.before.segments![0]!.start).toBe("2026-11-16");
    expect(step.changes[0]!.before.vacation).toEqual(["2026-11-16"]);
  });

  it("文字编辑区域保留原生撤回", () => {
    for (const html of ['<input />', '<textarea></textarea>', '<div contenteditable="true"><span></span></div>', '<div role="textbox"></div>']) {
      const container = document.createElement("div");
      container.innerHTML = html;
      expect(isTextUndoTarget(container.querySelector("span") ?? container.firstElementChild)).toBe(true);
    }
    expect(isTextUndoTarget(document.createElement("button"))).toBe(false);
  });
});

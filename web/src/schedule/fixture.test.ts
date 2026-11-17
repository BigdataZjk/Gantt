// 共享 fixture 一致性测试：与 Go internal/schedule/schedule_test.go 使用同一份
// testdata/schedule/cases.json，保证前后端排期规则完全一致。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ScheduleError,
  addDays,
  addSegment,
  countWorkdays,
  defaultCalendar,
  displayDays,
  isSupportedYear,
  isWorkday,
  moveSegment,
  normalize,
  overlaps,
  overlapDays,
  gaps,
  effectiveDays,
  effectiveSegments,
  removeSegment,
  resizeSegment,
  sequence,
  setDays,
  setDelivery,
  setOvertime,
  setVacation,
  tryNormalize,
} from "./index";
import type { Plan, SequenceRequest } from "./index";

interface Fixture {
  calendarIsWorkday: { date: string; expected: boolean; note?: string }[];
  calendarSupportedYear: { year: number; expected: boolean }[];
  addDays: { date: string; n: number; expected: string }[];
  countWorkdays: { start: string; end: string; expected: number; note?: string }[];
  displayDays: { days: number; expected: number }[];
  normalize: {
    name: string;
    input: Plan;
    expected?: Plan;
    errorCode?: string;
  }[];
  gaps: { name: string; plan: Plan; expected: unknown[] }[];
  effectiveSegments: { name: string; plan: Plan; expected: unknown[] }[];
  effectiveDays: { name: string; plan: Plan; expected: number }[];
  overlap: {
    name: string;
    a: Plan;
    b: Plan;
    expectedOverlapDays: number;
    expectedOverlaps: boolean;
  }[];
  moveSegment: {
    name: string;
    input: Plan;
    index: number;
    newStart: string;
    expected?: Plan;
    errorCode?: string;
  }[];
  resizeSegment: {
    name: string;
    input: Plan;
    index: number;
    edge: "start" | "end";
    date: string;
    expected?: Plan;
    errorCode?: string;
  }[];
  removeSegment: {
    name: string;
    input: Plan;
    index: number;
    expected?: Plan;
    errorCode?: string;
  }[];
  addSegment: {
    name: string;
    input: Plan;
    start: string;
    end: string;
    expected?: Plan;
    errorCode?: string;
  }[];
  setDays: {
    name: string;
    input: Plan;
    days: number;
    expected?: Plan;
    errorCode?: string;
  }[];
  setDelivery: {
    name: string;
    input: Plan;
    delivery: string;
    expected?: Plan;
    errorCode?: string;
  }[];
  setVacation: {
    name: string;
    input: Plan;
    date: string;
    on: boolean;
    expected?: Plan;
    errorCode?: string;
  }[];
  setOvertime: {
    name: string;
    input: Plan;
    date: string;
    on: boolean;
    expected?: Plan;
    errorCode?: string;
  }[];
  sequence: {
    name: string;
    requests: SequenceRequest[];
    expected?: { changes: unknown[]; warnings: string[]; selectedCount: number };
    errorCode?: string;
  }[];
}

// Vitest + jsdom 下 import.meta.url 可能是 http URL，此时回退到 web/ 工作目录；
// 两种方式都指向仓库根 testdata/schedule/cases.json。
const moduleUrl = import.meta.url;
const moduleDir = moduleUrl.startsWith("file:")
  ? path.dirname(fileURLToPath(moduleUrl))
  : path.resolve(process.cwd(), "src/schedule");
const fixturePath = path.resolve(
  moduleDir,
  "../../../testdata/schedule/cases.json",
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const calendar = defaultCalendar();

function captureError(run: () => unknown): ScheduleError | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ScheduleError) {
      return error;
    }
    throw error;
  }
}

function expectErrorCode(run: () => unknown, code: string | undefined): void {
  const error = captureError(run);
  if (!code) {
    if (error) {
      throw new Error(`预期成功，实际抛出 ${error.code}: ${error.message}`);
    }
    return;
  }
  expect(error, `预期抛出 ${code}`).not.toBeNull();
  expect(error?.code).toBe(code);
}

describe("共享日历", () => {
  it("默认日历覆盖 2025/2026/2027", () => {
    expect(calendar.years).toEqual([2025, 2026, 2027]);
    expect(calendar.source).not.toBe("");
    expect(calendar.restDays.length).toBeGreaterThan(0);
    expect(calendar.workDays.length).toBeGreaterThan(0);
  });

  it.each(fixture.calendarIsWorkday)("isWorkday $date = $expected", (item) => {
    expect(isWorkday(item.date, calendar)).toBe(item.expected);
  });

  it.each(fixture.calendarSupportedYear)(
    "isSupportedYear $year = $expected",
    (item) => {
      expect(isSupportedYear(item.year, calendar)).toBe(item.expected);
    },
  );

  it.each(fixture.addDays)("addDays($date, $n) = $expected", (item) => {
    expect(addDays(item.date, item.n)).toBe(item.expected);
  });

  it.each(fixture.countWorkdays)(
    "countWorkdays($start, $end) = $expected",
    (item) => {
      expect(countWorkdays(item.start, item.end, calendar)).toBe(item.expected);
    },
  );

  it.each(fixture.displayDays)("displayDays($days) = $expected", (item) => {
    expect(displayDays({ segments: [], days: item.days, start: "", delivery: "", vacation: [], overtime: [] })).toBe(
      item.expected,
    );
  });

  it("非法日期：addDays 返回空串，isWorkday 返回 false", () => {
    expect(addDays("2026-2-1", 1)).toBe("");
    expect(isWorkday("2026-02-30", calendar)).toBe(false);
    expect(isWorkday("", calendar)).toBe(false);
  });

  it("同一 calendar 对象重复查询结果稳定", () => {
    const sample = ["2026-01-01", "2026-02-14", "2026-11-16", "2027-01-01"];
    const first = sample.map((day) => isWorkday(day, calendar));
    const second = sample.map((day) => isWorkday(day, calendar));
    expect(second).toEqual(first);
    expect(first).toEqual([false, true, true, false]);
  });
});

describe("normalize 归一化", () => {
  it.each(fixture.normalize)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(() => normalize(item.input, calendar), item.errorCode);
      return;
    }
    const result = normalize(item.input, calendar);
    expect(result).toEqual(item.expected);
    expect(normalize(result, calendar)).toEqual(result);
  });

  it("tryNormalize 返回错误码而不是抛异常", () => {
    const result = tryNormalize(
      {
        segments: [
          { start: "2026-11-16", end: "2026-11-20" },
          { start: "2026-11-19", end: "2026-11-23" },
        ],
        days: 0,
        start: "",
        delivery: "",
        vacation: [],
        overtime: [],
      },
      calendar,
    );
    expect(result).toEqual({
      ok: false,
      code: "segment_overlap",
      message: "排期段之间不能重叠",
    });
  });
});

describe("HOLD 间隔与并行", () => {
  it.each(fixture.gaps)("$name", (item) => {
    expect(gaps(item.plan, calendar)).toEqual(item.expected);
  });

  it.each(fixture.effectiveSegments)("$name", (item) => {
    expect(effectiveSegments(item.plan)).toEqual(item.expected);
  });

  it.each(fixture.effectiveDays)("$name", (item) => {
    expect(effectiveDays(item.plan, calendar)).toBe(item.expected);
  });

  it.each(fixture.overlap)("$name", (item) => {
    expect(overlapDays(item.a, item.b, calendar)).toBe(item.expectedOverlapDays);
    expect(overlaps(item.a, item.b, calendar)).toBe(item.expectedOverlaps);
  });
});

describe("排期段操作", () => {
  it.each(fixture.moveSegment)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => moveSegment(item.input, calendar, item.index, item.newStart),
        item.errorCode,
      );
      return;
    }
    expect(moveSegment(item.input, calendar, item.index, item.newStart)).toEqual(
      item.expected,
    );
  });

  it.each(fixture.resizeSegment)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => resizeSegment(item.input, calendar, item.index, item.edge, item.date),
        item.errorCode,
      );
      return;
    }
    expect(
      resizeSegment(item.input, calendar, item.index, item.edge, item.date),
    ).toEqual(item.expected);
  });

  it.each(fixture.removeSegment)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => removeSegment(item.input, calendar, item.index),
        item.errorCode,
      );
      return;
    }
    expect(removeSegment(item.input, calendar, item.index)).toEqual(item.expected);
  });

  it.each(fixture.addSegment)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => addSegment(item.input, calendar, item.start, item.end),
        item.errorCode,
      );
      return;
    }
    expect(addSegment(item.input, calendar, item.start, item.end)).toEqual(
      item.expected,
    );
  });

  it.each(fixture.setDays)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => setDays(item.input, calendar, item.days),
        item.errorCode,
      );
      return;
    }
    expect(setDays(item.input, calendar, item.days)).toEqual(item.expected);
  });

  it.each(fixture.setDelivery)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => setDelivery(item.input, calendar, item.delivery),
        item.errorCode,
      );
      return;
    }
    expect(setDelivery(item.input, calendar, item.delivery)).toEqual(
      item.expected,
    );
  });

  it.each(fixture.setVacation)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => setVacation(item.input, calendar, item.date, item.on),
        item.errorCode,
      );
      return;
    }
    expect(setVacation(item.input, calendar, item.date, item.on)).toEqual(
      item.expected,
    );
  });

  it.each(fixture.setOvertime)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(
        () => setOvertime(item.input, calendar, item.date, item.on),
        item.errorCode,
      );
      return;
    }
    expect(setOvertime(item.input, calendar, item.date, item.on)).toEqual(
      item.expected,
    );
  });
});

describe("顺排预览", () => {
  it.each(fixture.sequence)("$name", (item) => {
    if (item.errorCode) {
      expectErrorCode(() => sequence(item.requests, calendar), item.errorCode);
      return;
    }
    expect(sequence(item.requests, calendar)).toEqual(item.expected);
  });

  it("顺排不修改入参", () => {
    const requests: SequenceRequest[] = [
      {
        id: "a",
        name: "需求A",
        developer: "李明",
        selected: true,
        plan: {
          segments: [{ start: "2026-11-16", end: "2026-11-20" }],
          days: 5,
          start: "2026-11-16",
          delivery: "2026-11-20",
          vacation: [],
          overtime: [],
        },
      },
      {
        id: "u",
        name: "未选U",
        developer: "李明",
        selected: false,
        plan: {
          segments: [{ start: "2026-11-18", end: "2026-11-19" }],
          days: 2,
          start: "2026-11-18",
          delivery: "2026-11-19",
          vacation: [],
          overtime: [],
        },
      },
    ];
    const snapshot = JSON.stringify(requests);
    sequence(requests, calendar);
    expect(JSON.stringify(requests)).toBe(snapshot);
  });
});

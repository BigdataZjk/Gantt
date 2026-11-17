// 顺排预览：按开发人分别向后顺排，保留未选需求的衔接/交叠关系与段间空档。
// 行为与 Go internal/schedule/sequence.go 一致，预览不修改入参。

import {
  type Calendar,
  addDays,
  internal,
  validDate,
} from "./calendar";
import {
  type Plan,
  deliveryOf,
  normalize,
  overlapDays,
  overlaps,
} from "./core";
import { ScheduleError, ScheduleErrorCode as Code } from "./errors";
import { movePlan } from "./ops";

export interface SequenceRequest {
  id: string;
  name: string;
  developer: string;
  selected: boolean;
  plan: Plan;
}

export interface SequenceChange {
  id: string;
  before: Plan;
  after: Plan;
  selected: boolean;
}

export interface SequenceResult {
  changes: SequenceChange[];
  warnings: string[];
  selectedCount: number;
}

function scheduleRelation(
  previous: Plan,
  next: Plan,
  calendar: Calendar,
): { working: boolean; offset: number } {
  const idx = internal.calendarIndex(calendar);
  const end = deliveryOf(previous, calendar);
  if (end === "" || next.start === "") {
    return { working: false, offset: 0 };
  }
  if (
    internal.isWorkdayIn(idx, end) &&
    internal.isWorkdayIn(idx, next.start)
  ) {
    return {
      working: true,
      offset: internal.workingOffsetIn(idx, end, next.start),
    };
  }
  return { working: false, offset: internal.daySpan(end, next.start) };
}

function sequenceEligible(
  request: SequenceRequest,
  calendar: Calendar,
): boolean {
  if (request.developer === "") {
    return false;
  }
  if (!validDate(request.plan.start)) {
    return false;
  }
  return validDate(deliveryOf(request.plan, calendar));
}

function sortSequenceRows(rows: SequenceRequest[]): SequenceRequest[] {
  return [...rows].sort((a, b) => {
    if (a.plan.start !== b.plan.start) {
      return a.plan.start < b.plan.start ? -1 : 1;
    }
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return 0;
  });
}

/**
 * 与原型一致：连续勾选的需求分成多个块分别后移；未勾选需求不拆块，
 * 因此会与相邻需求一起被锁定、只能整体保持相对关系。
 */
function buildBlocks(rows: SequenceRequest[]): SequenceRequest[][] {
  const blocks: SequenceRequest[][] = [];
  rows.forEach((row, i) => {
    if (i === 0 || (rows[i - 1].selected && row.selected)) {
      blocks.push([]);
    }
    blocks[blocks.length - 1].push(row);
  });
  return blocks;
}

function rowIndexOf(rows: SequenceRequest[], id: string): number {
  return rows.findIndex((row) => row.id === id);
}

function requestLabel(request: SequenceRequest): string {
  return request.name !== "" ? request.name : request.id;
}

function joinRequestNames(rows: SequenceRequest[]): string {
  return rows.map(requestLabel).join("、");
}

function moveBlock(
  block: SequenceRequest[],
  start: string,
  calendar: Calendar,
): Plan[] {
  const idx = internal.calendarIndex(calendar);
  const plans: Plan[] = [];
  for (let i = 0; i < block.length; i += 1) {
    let target = start;
    if (i > 0) {
      const relation = scheduleRelation(
        block[i - 1].plan,
        block[i].plan,
        calendar,
      );
      const previous = plans[i - 1].delivery;
      target = relation.working
        ? internal.shiftWorkdaysIn(idx, previous, relation.offset)
        : addDays(previous, relation.offset);
      if (target === "") {
        throw new ScheduleError(
          Code.rangeExceeded,
          "排期日期超出支持范围或跨度超过 5 年",
        );
      }
    }
    const next = movePlan(block[i].plan, calendar, target);
    if (i > 0) {
      const before = scheduleRelation(
        block[i - 1].plan,
        block[i].plan,
        calendar,
      );
      const after = scheduleRelation(plans[i - 1], next, calendar);
      if (
        before.working !== after.working ||
        before.offset !== after.offset ||
        overlapDays(block[i - 1].plan, block[i].plan, calendar) !==
          overlapDays(plans[i - 1], next, calendar)
      ) {
        throw new ScheduleError(
          Code.invalidPlan,
          "无法同时保持未选需求的原有关系和交叠天数，请一并勾选相邻需求",
        );
      }
    }
    plans.push(next);
  }
  return plans;
}

/**
 * 计算顺排预览：按开发人独立处理，选中需求依次向后贴紧；
 * 未选中的中间需求保持与前后的衔接与交叠关系，因此可能作为随动需求进入 changes。
 * 分段之间的工作日空档（真 HOLD）保持不变；无法保持约束时写入 warnings。
 * 返回结果不修改入参，应用由调用方根据 changes 写回。
 */
export function sequence(
  requests: SequenceRequest[],
  calendar: Calendar,
): SequenceResult {
  const normalized: SequenceRequest[] = requests.map((request) => ({
    ...request,
    plan: normalize(request.plan, calendar),
  }));
  const result: SequenceResult = {
    changes: [],
    warnings: [],
    selectedCount: 0,
  };
  const warned = new Set<string>();
  const addWarning = (message: string) => {
    if (message === "" || warned.has(message)) {
      return;
    }
    warned.add(message);
    result.warnings.push(message);
  };

  const developers: string[] = [];
  const seenDeveloper = new Set<string>();
  for (const request of normalized) {
    if (!request.selected || !sequenceEligible(request, calendar)) {
      continue;
    }
    result.selectedCount += 1;
    if (!seenDeveloper.has(request.developer)) {
      seenDeveloper.add(request.developer);
      developers.push(request.developer);
    }
  }

  for (const developer of developers) {
    const rows = sortSequenceRows(
      normalized.filter(
        (request) =>
          request.developer === developer &&
          sequenceEligible(request, calendar),
      ),
    );
    const blocks = buildBlocks(rows);

    for (const block of blocks) {
      const chosen = block.filter((row) => row.selected);
      const locked = block.filter((row) => !row.selected);
      if (chosen.length > 1 && locked.length > 0) {
        let overlapped = false;
        for (let i = 1; i < block.length; i += 1) {
          if (overlaps(block[i - 1].plan, block[i].plan, calendar)) {
            overlapped = true;
            break;
          }
        }
        if (overlapped) {
          addWarning(
            `${developer}：“${joinRequestNames(locked)}”未选中，需保持其与前后需求的衔接和交叠关系；“${joinRequestNames(chosen)}”不能分开顺排。`,
          );
        }
      }
    }

    const placed: SequenceRequest[] = [];
    for (const block of blocks) {
      let latest = "";
      for (const row of placed) {
        const delivery = deliveryOf(row.plan, calendar);
        if (delivery > latest) {
          latest = delivery;
        }
      }
      let start = block[0].plan.start;
      if (latest !== "") {
        const earliest = internal.nextWorkdayIn(
          internal.calendarIndex(calendar),
          addDays(latest, 1),
        );
        if (earliest > start) {
          start = earliest;
        }
      }
      let moved: Plan[] | null = null;
      if (start !== block[0].plan.start) {
        try {
          moved = moveBlock(block, start, calendar);
        } catch (error) {
          if (!(error instanceof ScheduleError)) {
            throw error;
          }
          addWarning(`${developer}：${error.message}`);
        }
      }
      const placedBlock: SequenceRequest[] = [];
      block.forEach((row, i) => {
        const next: SequenceRequest = {
          ...row,
          plan: moved ? moved[i] : row.plan,
        };
        placedBlock.push(next);
        if (JSON.stringify(row.plan) !== JSON.stringify(next.plan)) {
          result.changes.push({
            id: row.id,
            before: row.plan,
            after: next.plan,
            selected: row.selected,
          });
        }
      });
      placed.push(...placedBlock);
    }

    const chosen = placed.filter((row) => row.selected);
    for (let a = 0; a < chosen.length; a += 1) {
      for (let b = a + 1; b < chosen.length; b += 1) {
        if (!overlaps(chosen[a].plan, chosen[b].plan, calendar)) {
          continue;
        }
        let left = rowIndexOf(rows, chosen[a].id);
        let right = rowIndexOf(rows, chosen[b].id);
        if (left > right) {
          [left, right] = [right, left];
        }
        const between = rows
          .slice(left + 1, right)
          .filter((row) => !row.selected);
        const constraint =
          between.length > 0
            ? `中间的“${joinRequestNames(between)}”未选中，需要保持前后关系`
            : "受未选需求或特殊日期约束";
        addWarning(
          `${developer}：“${requestLabel(chosen[a])}”与“${requestLabel(chosen[b])}”仍有交叠；${constraint}。`,
        );
      }
    }
  }
  return result;
}

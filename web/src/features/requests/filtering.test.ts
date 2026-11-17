import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../../app/uiState";
import { filterRequests, scopeRequests } from "./filtering";
import { request } from "../../test/fixtures";

const rows = [
  request({ id: 1, domain: "流量域", requestType: "常规需求", status: "待开发", priority: "P1", developer: "u1", start: "2026-11-16", delivery: "2026-11-18", name: "订单看板", requester: "产品-小林", notes: "重点" }),
  request({ id: 2, domain: "广告域", requestType: "数据需求", status: "HOLD", priority: "P0", developer: "u2", start: "2026-11-20", delivery: "2026-11-24", name: "广告回流", requester: "业务-王姐", notes: "" }),
  request({ id: 3, domain: "", requestType: "常规需求", status: "待评审", priority: "P2", developer: "", start: "2026-12-01", delivery: "2026-12-03", name: "渠道归因", requester: "增长团队", notes: "" }),
  request({ id: 4, domain: "流量域", requestType: "常规需求", status: "已完成", priority: "P1", developer: "u1", start: "2026-11-10", delivery: "2026-11-12", name: "旧需求", requester: "产品-小林", notes: "", archived: true }),
];

describe("需求筛选", () => {
  it("按归档范围拆分", () => {
    expect(scopeRequests(rows, "pool").map((row) => row.id)).toEqual([1, 2, 3]);
    expect(scopeRequests(rows, "archive").map((row) => row.id)).toEqual([4]);
    expect(scopeRequests(rows, "gantt").map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("未排期、未分配和日期轴外的未归档需求都属于甘特图和需求池", () => {
    const all = [...rows, request({ id: 5, start: "", delivery: "", developer: "u1" }), request({ id: 6, start: "", delivery: "", developer: "" })];
    const gantt = filterRequests(scopeRequests(all, "gantt"), EMPTY_FILTERS, { applyDates: false });
    const pool = filterRequests(scopeRequests(all, "pool"), EMPTY_FILTERS, { applyDates: true });
    expect(gantt.map((row) => row.id)).toEqual([1, 2, 3, 5, 6]);
    expect(gantt).toEqual(pool);
  });

  it("多选业务域/状态/开发人/优先级", () => {
    expect(filterRequests(rows, { ...EMPTY_FILTERS, domain: ["流量域", "广告域"] }, { applyDates: true }).map((row) => row.id)).toEqual([1, 2, 4]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, status: ["HOLD"] }, { applyDates: true }).map((row) => row.id)).toEqual([2]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, developer: ["unassigned"] }, { applyDates: true }).map((row) => row.id)).toEqual([3]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, priority: ["P0", "P1"] }, { applyDates: true }).map((row) => row.id)).toEqual([1, 2, 4]);
    const none = filterRequests(rows, { ...EMPTY_FILTERS, priority: [] }, { applyDates: true });
    expect(none).toHaveLength(4);
  });

  it("日期与关键词筛选", () => {
    expect(filterRequests(rows, { ...EMPTY_FILTERS, start: "2026-11-15" }, { applyDates: true }).map((row) => row.id)).toEqual([1, 2, 3]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, end: "2026-11-18" }, { applyDates: true }).map((row) => row.id)).toEqual([1, 4]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, query: "广告" }, { applyDates: true }).map((row) => row.id)).toEqual([2]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, query: "重点" }, { applyDates: true }).map((row) => row.id)).toEqual([1]);
    expect(filterRequests(rows, { ...EMPTY_FILTERS, start: "2026-11-15" }, { applyDates: false }).map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });
});

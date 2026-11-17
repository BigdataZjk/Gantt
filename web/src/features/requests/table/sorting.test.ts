import { describe, expect, it } from "vitest";
import { request, users } from "../../../test/fixtures";
import { newestRequests, normalizeTableSort, sortRequests, toggleTableSort } from "./sorting";

const ids = (rows: ReturnType<typeof request>[]) => rows.map((row) => row.id);

describe("需求列表排序", () => {
  it("默认使用最近进池或归档时间，支持纳秒及旧记录回退", () => {
    const rows = [
      request({ id: 1, poolEnteredAt: "2026-11-18T01:00:00.000000002Z", archivedAt: "2026-11-18T02:00:00Z" }),
      request({ id: 2, poolEnteredAt: "2026-11-18T01:00:00.000000001Z", archivedAt: "2026-11-18T03:00:00Z" }),
      request({ id: 3 }),
      request({ id: 4 }),
    ];
    expect(ids(newestRequests(rows, false))).toEqual([1, 2, 4, 3]);
    expect(ids(newestRequests(rows, true))).toEqual([2, 1, 4, 3]);
    expect(ids(rows)).toEqual([1, 2, 3, 4]);
  });

  it("按点击顺序级联，切换已有字段不改变优先顺序", () => {
    let sorting = toggleTableSort([], "domain");
    sorting = toggleTableSort(sorting, "days");
    sorting = toggleTableSort(sorting, "domain");
    expect(sorting).toEqual([{ key: "domain", direction: "desc" }, { key: "days", direction: "asc" }]);
    const rows = [request({ id: 1, domain: "B", days: 10 }), request({ id: 2, domain: "A", days: 3 }), request({ id: 3, domain: "B", days: 2 })];
    expect(ids(sortRequests(rows, sorting, users))).toEqual([3, 1, 2]);
    expect(ids(sortRequests(rows, [], users))).toEqual([1, 2, 3]);
  });

  it("开发人按显示姓名排序，日期取实际交付，空值始终置后", () => {
    const rows = [
      request({ id: 1, developer: "u2", delivery: "2026-11-20" }),
      request({ id: 2, developer: "", delivery: "", start: "" }),
      request({ id: 3, developer: "u1", delivery: "2026-11-19" }),
    ];
    const names = [{ ...users[0], username: "A" }, { ...users[1], username: "B" }];
    expect(ids(sortRequests(rows, [{ key: "developer", direction: "asc" }], names))).toEqual([3, 1, 2]);
    expect(ids(sortRequests(rows, [{ key: "developer", direction: "desc" }], names))).toEqual([1, 3, 2]);
    expect(ids(sortRequests(rows, [{ key: "delivery", direction: "asc" }], users))).toEqual([3, 1, 2]);
    expect(ids(sortRequests(rows, [{ key: "delivery", direction: "desc" }], users))).toEqual([1, 3, 2]);
  });

  it("中文和数字自然排序，相同值维持默认次序，忽略无效持久化配置", () => {
    const rows = [request({ id: 1, name: "需求10" }), request({ id: 2, name: "需求2" }), request({ id: 3, name: "需求2" })];
    expect(ids(sortRequests(rows, [{ key: "name", direction: "asc" }], users))).toEqual([2, 3, 1]);
    expect(normalizeTableSort([null, "name", { key: "name", direction: "asc" }, { key: "name", direction: "desc" }, { key: "secret", direction: "asc" }, { key: "days", direction: "invalid" }])).toEqual([{ key: "name", direction: "asc" }]);
  });
});

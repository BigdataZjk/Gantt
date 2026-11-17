import { describe, expect, it } from "vitest";
import { reorderVisibleIds, sortBySavedOrder } from "./rowOrder";

describe("个人需求展示顺序", () => {
  it("旧顺序保留、新需求追加，已删除的编号不生成行", () => {
    expect(sortBySavedOrder([{ id: 2 }, { id: 1 }, { id: 3 }, { id: 4 }], [99, 1, 2]).map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });

  it("支持前后插入，原地放下不保存", () => {
    expect(reorderVisibleIds([1, 2, 3, 4], [1, 2, 3, 4], 1, 3, "after")).toEqual([2, 3, 1, 4]);
    expect(reorderVisibleIds([1, 2, 3, 4], [1, 2, 3, 4], 4, 2, "before")).toEqual([1, 4, 2, 3]);
    expect(reorderVisibleIds([1, 2], [1, 2], 1, 2, "before")).toBeNull();
    expect(reorderVisibleIds([1, 2], [1, 2], 1, 1, "after")).toBeNull();
  });

  it("筛选时只重排可见槽位，不丢失或移动隐藏需求", () => {
    expect(reorderVisibleIds([1, 2, 3, 4, 5], [1, 3, 5], 5, 1, "before")).toEqual([5, 2, 1, 4, 3]);
    expect(reorderVisibleIds([1, 2, 3], [1, 3], 1, 2, "after")).toBeNull();
    expect(reorderVisibleIds([1, 2, 3], [1, 3], 2, 3, "after")).toBeNull();
    expect(reorderVisibleIds([1, 2], [1, 2, 3], 3, 1, "before")).toBeNull();
  });
});

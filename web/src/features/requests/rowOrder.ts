export type DropEdge = "before" | "after";

export function sortBySavedOrder<T extends { id: number }>(rows: T[], order: number[], prependNew = false): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const missing = prependNew ? -1 : Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => (rank.get(a.id) ?? missing) - (rank.get(b.id) ?? missing));
}

export function reorderVisibleIds(allIds: number[], visibleIds: number[], source: number, target: number, edge: DropEdge): number[] | null {
  if (source === target || !visibleIds.includes(source) || !visibleIds.includes(target)) return null;
  const visible = new Set(visibleIds);
  const reordered = allIds.filter((id) => visible.has(id) && id !== source);
  const targetIndex = reordered.indexOf(target);
  if (targetIndex < 0 || !allIds.includes(source)) return null;
  reordered.splice(targetIndex + (edge === "after" ? 1 : 0), 0, source);
  let cursor = 0;
  const next = allIds.map((id) => visible.has(id) ? reordered[cursor++]! : id);
  return next.some((id, index) => id !== allIds[index]) ? next : null;
}

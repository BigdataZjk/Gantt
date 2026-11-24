import { Archive, Copy, Eye, Link, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { ApiRequest } from "../../api/types";
import { copyText } from "../../lib/clipboard";
import type { ContextMenuItem } from "../../ui/ContextMenu";

export function requestMenuItems(row: ApiRequest, actions: {
  canEdit: boolean;
  onOpen: (id: number) => void;
  onDelete: (row: ApiRequest) => void;
  onArchive: (row: ApiRequest) => void;
  onRestore?: (row: ApiRequest) => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (row.archived && actions.canEdit && actions.onRestore) {
    items.push({ key: "restore", label: "恢复到需求池", icon: RotateCcw, onSelect: () => actions.onRestore?.(row) });
  } else if (!actions.canEdit || row.archived) {
    items.push({ key: "details", label: "查看详情", icon: Eye, onSelect: () => actions.onOpen(row.id) });
  } else {
    items.push(
      { key: "edit", label: "编辑", icon: Pencil, onSelect: () => actions.onOpen(row.id) },
      { key: "archive", label: "归档", icon: Archive, onSelect: () => actions.onArchive(row) },
    );
  }
  items.push({ key: "copyName", label: "复制需求名", icon: Copy, separatorBefore: true, onSelect: () => void copyText(row.name) });
  if (row.prd.trim()) items.push({ key: "copyPrd", label: "复制PRD地址", icon: Link, onSelect: () => void copyText(row.prd) });
  if (row.wangyue.trim()) items.push({ key: "copyWangyue", label: "复制望岳地址", icon: Link, onSelect: () => void copyText(row.wangyue) });
  if (actions.canEdit && !row.archived) {
    items.push({ key: "delete", label: "删除", icon: Trash2, danger: true, separatorBefore: true, onSelect: () => actions.onDelete(row) });
  }
  return items;
}

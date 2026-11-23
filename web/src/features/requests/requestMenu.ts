import { Archive, Eye, Pencil, Trash2 } from "lucide-react";
import type { ApiRequest } from "../../api/types";
import type { ContextMenuItem } from "../../ui/ContextMenu";

export function requestMenuItems(row: ApiRequest, actions: {
  canEdit: boolean;
  onOpen: (id: number) => void;
  onDelete: (row: ApiRequest) => void;
  onArchive: (row: ApiRequest) => void;
}): ContextMenuItem[] {
  if (!actions.canEdit || row.archived) return [{ key: "details", label: "查看详情", icon: Eye, onSelect: () => actions.onOpen(row.id) }];
  return [
    { key: "edit", label: "编辑", icon: Pencil, onSelect: () => actions.onOpen(row.id) },
    { key: "archive", label: "归档", icon: Archive, onSelect: () => actions.onArchive(row) },
    { key: "delete", label: "删除", icon: Trash2, danger: true, separatorBefore: true, onSelect: () => actions.onDelete(row) },
  ];
}

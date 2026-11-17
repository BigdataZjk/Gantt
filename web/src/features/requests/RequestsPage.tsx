import { useCallback, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useMutationRunner } from "../../api/hooks";
import { useNotice } from "../../ui/Notice";
import { isDraftMeaningful } from "../../lib/draft";
import { Archive, ChartNoAxesGantt, List } from "lucide-react";
import type { ApiRequest, State } from "../../api/types";
import { useUiState } from "../../app/uiState";
import { PageTabs } from "../../ui/Tabs";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import type { RequestPermissions, EditorRequest } from "./types";
export type { EditorRequest };
import { filterRequests, scopeRequests } from "./filtering";
import { FilterBar } from "./FilterBar";
import type { GanttUndo } from "./gantt/useGanttUndo";
import { GanttView } from "./gantt/GanttView";
import { RequestTable } from "./table/RequestTable";
import { RequestDrawer } from "./form/RequestDrawer";
import { RequestDetailsDrawer } from "./details/RequestDetailsDrawer";
import styles from "./RequestsPage.module.css";

export interface RequestsPageProps {
  state: State;
  ganttUndo: GanttUndo;
  permissions: RequestPermissions;
  onLogin: () => void;
  onLogout: () => void;
  onOpenCredential: (action: { mode: "self" | "reset" | "view"; user?: import("../../api/types").User | null }) => void;
  onOpenProfile: () => void;
  editor: EditorRequest | null;
  onEditorChange: (editor: EditorRequest | null) => void;
}

export function RequestsPage({ state, permissions, onEditorChange, editor, ganttUndo }: RequestsPageProps) {
  const { ui, patch } = useUiState();
  const runner = useMutationRunner();
  const notice = useNotice();
  const [deleteTarget, setDeleteTarget] = useState<ApiRequest | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [ganttFitDays, setGanttFitDays] = useState(1);
  const [ganttControlsHost, setGanttControlsHost] = useState<HTMLDivElement | null>(null);

  const scoped = useMemo(() => scopeRequests(state.requests, ui.requirementTab), [state.requests, ui.requirementTab]);
  const filtered = useMemo(() => filterRequests(scoped, ui.filters, { applyDates: ui.requirementTab !== "gantt" }), [scoped, ui.filters, ui.requirementTab]);
  const draftHint = isDraftMeaningful(ui.newDraft);

  const openRequest = useCallback((id: number) => {
    if (permissions.canEdit) onEditorChange({ mode: "edit", id });
    else setDetailsId(id);
  }, [permissions.canEdit, onEditorChange]);
  const archiveRow = async (row: ApiRequest) => {
    const result = await runner((baseRevision) => api.archiveRequest(baseRevision, row.id, true));
    if (result) notice.notify("已归档，可在需求归档中查看");
  };
  const restoreRow = async (row: ApiRequest) => {
    const result = await runner((baseRevision) => api.archiveRequest(baseRevision, row.id, false));
    if (result) notice.notify("已恢复到需求池");
  };
  const deleteRow = async (row: ApiRequest) => {
    const result = await runner((baseRevision) => api.deleteRequest(baseRevision, row.id));
    if (result) notice.notify("需求已删除");
  };
  const openDetails = (id: number) => setDetailsId(id);

  return (
    <div className={styles.page}>
      <FilterBar
        state={state}
        scopeRows={scoped}
        tab={ui.requirementTab}
        ganttFitDays={ganttFitDays}
        ganttControlsRef={setGanttControlsHost}
        navigation={
          <PageTabs
            ariaLabel="需求视图"
            value={ui.requirementTab}
            onChange={(tab) => patch({ requirementTab: tab })}
            items={[
              { key: "gantt", label: "甘特图", icon: ChartNoAxesGantt },
              { key: "pool", label: "需求池", icon: List },
              { key: "archive", label: "已归档", icon: Archive },
            ]}
          />
        }
      />
      <div className={styles.content} data-scroll-container="requests-content">
        {ui.requirementTab === "gantt" ? (
          <GanttView undo={ganttUndo} state={state} permissions={permissions} rows={filtered} totalCount={scoped.length} draftHint={draftHint} onOpen={openRequest} onDelete={setDeleteTarget} onArchive={(row) => void archiveRow(row)} onFitDaysChange={setGanttFitDays} controlsHost={ganttControlsHost} />
        ) : (
          <RequestTable
            state={state}
            permissions={permissions}
            rows={filtered}
            totalCount={scoped.length}
            draftHint={draftHint}
            archive={ui.requirementTab === "archive"}
            onOpen={openRequest}
            onOpenDetails={openDetails}
            onDelete={(row) => setDeleteTarget(row)}
            onArchive={(row) => void archiveRow(row)}
            onRestore={(row) => void restoreRow(row)}
          />
        )}
      </div>

      <RequestDrawer
        state={state}
        permissions={permissions}
        editor={editor && editor.mode !== "archive" ? editor : null}
        onClose={() => onEditorChange(null)}
      />
      <RequestDetailsDrawer state={state} id={detailsId} onClose={() => setDetailsId(null)} />

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除需求"
        caption={deleteTarget?.name}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="danger" onClick={() => { const row = deleteTarget; setDeleteTarget(null); if (row) void deleteRow(row); }}>确认删除</Button>
          </>
        }
      >
        <p style={{ color: "var(--rsm-muted)" }}>确认删除“{deleteTarget?.name}”？此需求将从需求池和甘特图移除，操作记录保留。</p>
      </Dialog>
    </div>
  );
}

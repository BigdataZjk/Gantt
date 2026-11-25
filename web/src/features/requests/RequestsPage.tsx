import { useCallback, useEffect, useMemo, useState } from "react";
import { api, requestReflowCount } from "../../api/client";
import { useNotice } from "../../ui/Notice";
import { isDraftMeaningful } from "../../lib/draft";
import { Archive, ChartNoAxesGantt, List } from "lucide-react";
import type { ApiRequest, State } from "../../api/types";
import { useUiState, type UiState } from "../../app/uiState";
import { PageTabs } from "../../ui/Tabs";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import type { RequestPermissions, EditorRequest } from "./types";
export type { EditorRequest };
import { filterRequests, scopeRequests } from "./filtering";
import { FilterBar } from "./FilterBar";
import { requestHistoryShortcut, type RequestHistory } from "./useRequestHistory";
import { GanttView } from "./gantt/GanttView";
import { RequestTable } from "./table/RequestTable";
import { RequestDrawer } from "./form/RequestDrawer";
import { RequestDetailsDrawer } from "./details/RequestDetailsDrawer";
import styles from "./RequestsPage.module.css";

export interface RequestsPageProps {
  state: State;
  requestHistory: RequestHistory;
  permissions: RequestPermissions;
  onLogin: () => void;
  onLogout: () => void;
  onOpenCredential: (action: { mode: "self" | "reset" | "view"; user?: import("../../api/types").User | null }) => void;
  onOpenProfile: () => void;
  editor: EditorRequest | null;
  onEditorChange: (editor: EditorRequest | null) => void;
}

export function RequestsPage({ state, permissions, onEditorChange, editor, requestHistory }: RequestsPageProps) {
  const { ui, patch } = useUiState();
  const notice = useNotice();
  const [deleteTarget, setDeleteTarget] = useState<ApiRequest | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [ganttRange, setGanttRange] = useState<UiState["ganttRange"] | null>(null);

  useEffect(() => {
    if (!permissions.canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      const direction = requestHistoryShortcut(event);
      if (direction && requestHistory.replay(direction)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [permissions.canEdit, requestHistory]);

  const scoped = useMemo(() => scopeRequests(state.requests, ui.requirementTab), [state.requests, ui.requirementTab]);
  const filtered = useMemo(() => filterRequests(scoped, ui.filters, { applyDates: ui.requirementTab !== "gantt" }), [scoped, ui.filters, ui.requirementTab]);
  const draftHint = isDraftMeaningful(ui.newDraft);

  const openRequest = useCallback((id: number) => {
    if (permissions.canEdit && state.requests.some((row) => row.id === id && !row.archived)) onEditorChange({ mode: "edit", id });
    else setDetailsId(id);
  }, [permissions.canEdit, state.requests, onEditorChange]);
  const canReflowOnDelete = (row: ApiRequest) => permissions.isAdmin && Boolean(
    row.developer && (row.start || row.segments?.length || row.supportSegments?.length),
  );
  const archiveRow = async (row: ApiRequest) => {
    const result = await requestHistory.save((baseRevision) => api.archiveRequest(baseRevision, row.id, true));
    if (result) notice.notify("已归档，可在需求归档中查看");
  };
  const restoreRow = async (row: ApiRequest) => {
    const result = await requestHistory.save((baseRevision) => api.archiveRequest(baseRevision, row.id, false));
    if (result) notice.notify("已恢复到需求池");
  };
  const deleteRow = async (reflow: boolean) => {
    const row = deleteTarget;
    setDeleteTarget(null);
    if (!row) return;
    const result = await requestHistory.save((baseRevision) => api.deleteRequest(baseRevision, row.id, reflow));
    if (!result) return;
    const moved = requestReflowCount(result);
    if (moved) notice.notify(`需求已删除，${moved} 条排期已前移`);
    else if (moved === 0 && canReflowOnDelete(row)) notice.notify("需求已删除，后续排期保持原日期");
    else notice.notify("需求已删除");
  };
  const openDetails = (id: number) => setDetailsId(id);
  const showReflowChoice = Boolean(deleteTarget && canReflowOnDelete(deleteTarget));

  return (
    <div className={styles.page}>
      <FilterBar
        state={state}
        scopeRows={scoped}
        tab={ui.requirementTab}
        ganttRange={ganttRange}
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
          <GanttView requestHistory={requestHistory} state={state} permissions={permissions} rows={filtered} totalCount={scoped.length} draftHint={draftHint} onOpen={openRequest} onDelete={setDeleteTarget} onArchive={(row) => void archiveRow(row)} onDateRangeChange={setGanttRange} />
        ) : (
          <RequestTable
            state={state}
            save={requestHistory.save}
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
        save={requestHistory.save}
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
            {showReflowChoice ? (
              <>
                <Button variant="dangerText" onClick={() => void deleteRow(false)}>删除并保持排期</Button>
                <Button variant="danger" onClick={() => void deleteRow(true)}>删除并前移排期</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => void deleteRow(false)}>确认删除</Button>
            )}
          </>
        }
      >
        <p style={{ color: "var(--rsm-muted)" }}>确认删除“{deleteTarget?.name}”？此需求将从需求池和甘特图移除，操作记录保留。</p>
        {showReflowChoice ? (
          <p style={{ color: "var(--rsm-muted)" }}>要前移同一开发人的后续排期吗？前移时会保留并行、HOLD、休假、加班和补位。</p>
        ) : null}
      </Dialog>
    </div>
  );
}

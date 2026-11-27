import { useEffect } from "react";
import { CalendarDays, DatabaseBackup, History, ListFilter, ListTree, Megaphone, ScrollText, ShieldUser, UserRound } from "lucide-react";
import type { State, User } from "../../api/types";
import { useUiState } from "../../app/uiState";
import { PageTabs } from "../../ui/Tabs";
import type { RequestPermissions } from "../requests/types";
import { RolePanel } from "./roles/RolePanel";
import { FieldPanel } from "./fields/FieldPanel";
import { PersonalPanel } from "./personal/PersonalPanel";
import { LogsPanel } from "./logs/LogsPanel";
import { CalendarPanel } from "./calendar/CalendarPanel";
import { UpdatesPanel } from "./updates/UpdatesPanel";
import { VersionsPanel } from "./versions/VersionsPanel";
import { AnnouncementPanel } from "./announcement/AnnouncementPanel";
import { BackupPanel } from "./backup/BackupPanel";
import styles from "./Settings.module.css";

interface Props {
  state: State;
  permissions: RequestPermissions;
  onLogin: () => void;
  onLogout: () => void;
  onOpenCredential: (action: { mode: "self" | "reset" | "view"; user?: User | null }) => void;
}

export function SettingsPage({ state, permissions, onLogin, onLogout, onOpenCredential }: Props) {
  const { ui, patch } = useUiState();
  const serverVersion = state.serverVersion?.trim();

  useEffect(() => {
    const superOnly = ui.settingsTab === "fields" || ui.settingsTab === "announcement" || ui.settingsTab === "backup";
    if ((ui.settingsTab === "calendar" && !permissions.isAdmin) || (superOnly && !permissions.isSuper)) patch({ settingsTab: "roles" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.settingsTab, permissions.isSuper, permissions.isAdmin]);

  const items = [
    { key: "roles" as const, label: "角色权限", icon: ShieldUser },
    ...(permissions.isSuper ? [{ key: "fields" as const, label: "字段管理", icon: ListFilter }] : []),
    ...(permissions.isAdmin ? [{ key: "calendar" as const, label: "工作日历", icon: CalendarDays }] : []),
    ...(permissions.isSuper ? [{ key: "announcement" as const, label: "公告设置", icon: Megaphone }] : []),
    { key: "personal" as const, label: "个性化", icon: UserRound },
    { key: "logs" as const, label: "操作记录", icon: ScrollText },
    { key: "versions" as const, label: "版本记录", icon: History },
    ...(permissions.isSuper ? [{ key: "backup" as const, label: "数据备份", icon: DatabaseBackup }] : []),
    { key: "updates" as const, label: "更新日志", icon: ListTree },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.tabsRow}>
        <PageTabs ariaLabel="设置分类" value={ui.settingsTab} onChange={(tab) => patch({ settingsTab: tab })} items={items} className={styles.settingsTabs} />
        {serverVersion ? (
          <span className={styles.serverVersion}>{serverVersion.startsWith("v") ? serverVersion : `v${serverVersion}`}</span>
        ) : null}
      </div>
      <div className={styles.panel} data-scroll-container="settings-content">
        {ui.settingsTab === "roles" ? <RolePanel state={state} permissions={permissions} onOpenCredential={onOpenCredential} /> : null}
        {ui.settingsTab === "fields" && permissions.isSuper ? <FieldPanel state={state} /> : null}
        {ui.settingsTab === "calendar" && permissions.isAdmin ? <CalendarPanel state={state} /> : null}
        {ui.settingsTab === "announcement" && permissions.isSuper ? <AnnouncementPanel announcement={state.announcement ?? ""} /> : null}
        {ui.settingsTab === "personal" ? <PersonalPanel state={state} permissions={permissions} onLogin={onLogin} onLogout={onLogout} onOpenCredential={onOpenCredential} /> : null}
        {ui.settingsTab === "logs" ? <LogsPanel state={state} permissions={permissions} /> : null}
        {ui.settingsTab === "versions" ? <VersionsPanel state={state} permissions={permissions} /> : null}
        {ui.settingsTab === "backup" && permissions.isSuper ? <BackupPanel /> : null}
        {ui.settingsTab === "updates" ? <UpdatesPanel serverVersion={serverVersion} /> : null}
      </div>
    </div>
  );
}

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarRange, LogIn, Megaphone } from "lucide-react";
import { api, ApiError } from "../api/client";
import { createStateWriter } from "../api/stateCache";
import type { Presence, State, User } from "../api/types";
import { usePreferences } from "./preferences";
import { useUiState } from "./uiState";
import { ThemeToggle } from "./ThemeToggle";
import { PresenceStack } from "./PresenceStack";
import { SearchBox } from "./SearchBox";
import { Sidebar } from "./Sidebar";
import { Button } from "../ui/Button";
import { CyberButton } from "../ui/CyberButton";
import { RainBackground } from "../ui/RainBackground";
import { GridBackground } from "../ui/GridBackground";
import { useNotice } from "../ui/Notice";
import { LoginDialog, PasswordDialog, type PasswordMode } from "../features/auth/AuthFlows";
import { RequestsPage, type EditorRequest } from "../features/requests/RequestsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { useRequestHistory } from "../features/requests/useRequestHistory";
import styles from "./AppShell.module.css";

export interface Permissions {
  isSuper: boolean;
  isAdmin: boolean;
  canEdit: boolean;
  guest: boolean;
}

export interface CredentialAction {
  mode: PasswordMode;
  user?: User | null;
}

const announcementGap = 48;
const announcementSpeed = 44;

function AnnouncementBanner({ text }: { text: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [duration, setDuration] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = textRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const width = content.getBoundingClientRect().width;
      setDuration(width > viewport.getBoundingClientRect().width ? (width + announcementGap) / announcementSpeed : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className={styles.announcement} role="region" aria-label="系统公告">
      <Megaphone aria-hidden="true" />
      <div ref={viewportRef} className={styles.announcementViewport} tabIndex={duration ? 0 : undefined}>
        <div
          key={text}
          className={styles.announcementTrack}
          data-scrolling={duration ? "" : undefined}
          style={duration ? { "--announcement-gap": `${announcementGap}px`, animationDuration: `${duration}s` } as CSSProperties : undefined}
        >
          <span ref={textRef}>{text}</span>
          {duration ? <span aria-hidden="true">{text}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function AppShell({ state, presence }: { state: State; presence: Presence }) {
  const { ui, patch, patchFilters } = useUiState();
  const { theme } = usePreferences();
  const notice = useNotice();
  const client = useQueryClient();
  const [loginOpen, setLoginOpen] = useState(false);
  const [credential, setCredential] = useState<CredentialAction | null>(null);
  const [editor, setEditor] = useState<EditorRequest | null>(null);

  const me = state.me;
  const guest = !me;
  const isSuper = me?.role === "superadmin";
  const isAdmin = isSuper || me?.role === "admin";
  const canEdit = isAdmin || me?.role === "collaborator";
  const permissions = useMemo<Permissions>(() => ({ isSuper, isAdmin, canEdit, guest }), [isSuper, isAdmin, canEdit, guest]);

  const requestHistory = useRequestHistory(me?.id);

  const showCreate = ui.mainView === "requirements";

  const logout = async () => {
    const writeState = createStateWriter(client, true);
    try {
      const next = await api.logout();
      if (!await writeState(next)) return;
      notice.notify("已退出登录");
      patch({ mainView: "requirements", settingsTab: "roles", newDraft: null });
    } catch (error) {
      notice.error(error instanceof ApiError ? error.message : "退出登录失败");
    }
  };

  const openProfile = () => {
    if (guest) {
      setLoginOpen(true);
      return;
    }
    patch({ mainView: "settings", settingsTab: "personal" });
  };

  return (
    <div className={styles.app} data-theme={theme}>
      {theme === "dark" ? <RainBackground className={styles.backgroundRain} /> : <GridBackground className={styles.backgroundRain} />}
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <CalendarRange aria-hidden="true" />
          <span title="Request Schedule Manager">RSM</span>
        </div>
        <div className={styles.topActions}>
          {showCreate ? (
            <CyberButton
              disabled={!canEdit}
              onClick={() => setEditor({ mode: "create" })}
              data-tooltip={!canEdit ? "只读或未登录时不可新增" : undefined}
            >
              新增需求
            </CyberButton>
          ) : null}
        </div>
        {state.announcement ? <AnnouncementBanner text={state.announcement} /> : null}
        <div className={styles.topEnd}>
          <SearchBox
            value={ui.filters.query}
            onChange={(query) => patchFilters({ query })}
            visible={ui.mainView === "requirements"}
          />
          <PresenceStack presence={presence} users={state.users} />
          <Button
            variant={guest ? "default" : "ghost"}
            size="sm"
            className={guest ? styles.loginButton : styles.accountButton}
            onClick={openProfile}
            aria-haspopup={guest ? "dialog" : undefined}
            data-tooltip={me?.username}
          >
            {guest ? <LogIn aria-hidden="true" /> : null}
            <span>{me?.username ?? "未登录"}</span>
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className={styles.shell}>
        <Sidebar />
        <main className={styles.main}>
          {ui.mainView === "requirements" ? (
            <RequestsPage
              state={state}
              permissions={permissions}
              onLogin={() => setLoginOpen(true)}
              onLogout={logout}
              onOpenCredential={setCredential}
              onOpenProfile={openProfile}
              editor={editor}
              onEditorChange={setEditor}
              requestHistory={requestHistory}
            />
          ) : (
            <SettingsPage
              state={state}
              permissions={permissions}
              onLogin={() => setLoginOpen(true)}
              onLogout={logout}
              onOpenCredential={setCredential}
            />
          )}
        </main>
      </div>

      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      <PasswordDialog
        open={Boolean(credential)}
        onOpenChange={(open) => { if (!open) setCredential(null); }}
        mode={credential?.mode ?? "self"}
        user={credential?.user ?? (credential?.mode === "self" ? me : null)}
      />
    </div>
  );
}

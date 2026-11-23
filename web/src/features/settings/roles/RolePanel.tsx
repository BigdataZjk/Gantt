import { useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import type { State, User } from "../../../api/types";
import { isValidPassword, isValidUsername } from "../../../lib/validation";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Drawer } from "../../../ui/Drawer";
import { PasswordInput } from "../../../ui/PasswordInput";
import { useNotice } from "../../../ui/Notice";
import { roleName } from "../../../lib/format";
import type { RequestPermissions } from "../../requests/types";
import styles from "../Settings.module.css";

interface Props {
  state: State;
  permissions: RequestPermissions;
  onOpenCredential: (action: { mode: "self" | "reset" | "view"; user?: User | null }) => void;
}

type ConfirmState = { kind: "delete" | "disable" | "enable"; user: User } | null;

interface AccountDraft {
  mode: "create" | "edit";
  user?: User;
  username: string;
  role: string;
  password: string;
}

export function RolePanel({ state, permissions, onOpenCredential }: Props) {
  const runner = useMutationRunner();
  const notice = useNotice();
  const [account, setAccount] = useState<AccountDraft | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const users = useMemo(() => state.users.filter((user) => !user.deleted), [state.users]);
  const canManage = (target: User) => {
    if (!permissions.isAdmin) return false;
    if (permissions.isSuper) return true;
    return target.role === "collaborator" || target.role === "readonly";
  };
  const canCreate = permissions.isSuper || permissions.isAdmin;
  const roleOptions = (target?: User) => (target?.role === "superadmin" ? ["superadmin"] : permissions.isSuper ? ["admin", "collaborator", "readonly"] : ["collaborator", "readonly"]);

  const openCreate = () => {
    setError("");
    setAccount({ mode: "create", username: "", role: permissions.isSuper ? "collaborator" : "collaborator", password: "" });
  };

  const openEdit = (user: User) => {
    setError("");
    setAccount({ mode: "edit", user, username: user.username, role: user.role, password: "" });
  };

  const commitAccount = async () => {
    if (!account) return;
    const username = account.username.trim();
    if (!username || !isValidUsername(username)) {
      setError("用户名可使用文字、数字、下划线、点和短横线");
      return;
    }
    if (account.mode === "create" && !isValidPassword(account.password)) {
      setError("初始密码至少 1 个字符");
      return;
    }
    if (account.mode === "edit" && account.user?.role === "superadmin" && account.role !== "superadmin") {
      setError("超级管理员不可降权");
      return;
    }
    setPending(true);
    setError("");
    let result: State | null;
    if (account.mode === "create") {
      result = await runner(() => api.createUser({ username, password: account.password, role: account.role }));
    } else {
      const patch: Record<string, unknown> = { role: account.role };
      if (account.password) patch.password = account.password;
      result = await runner(() => api.updateUser(account.user!.id, patch));
    }
    setPending(false);
    if (result) {
      notice.notify(account.mode === "create" ? "账号已创建" : "账号已更新");
      setAccount(null);
    }
  };

  const act = async (kind: "delete" | "disable" | "enable", user: User) => {
    const patch: Record<string, unknown> = kind === "delete" ? { deleted: true } : kind === "disable" ? { disabled: true } : { disabled: false };
    const result = await runner(() => api.updateUser(user.id, patch));
    if (result) {
      notice.notify(kind === "delete" ? "账号已删除，历史需求保留" : kind === "disable" ? "账号已停用" : "账号已启用");
      setConfirm(null);
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>角色权限</h2>
          <p className={styles.caption}>共 {users.length} 个账号。角色决定可编辑范围；停用或删除账号不会影响历史需求与日志。</p>
        </div>
        <Button variant="primary" disabled={!canCreate} onClick={openCreate}>
          <UserPlus aria-hidden="true" />
          新增账号
        </Button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="账号列表">
          <thead>
            <tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {users.length ? users.map((user) => {
              const manageable = canManage(user);
              const protectedSuper = user.role === "superadmin";
              return (
                <tr key={user.id}>
                  <td>{user.username}{state.me?.id === user.id ? "（本人）" : ""}</td>
                  <td>{roleName(user.role)}</td>
                  <td>{user.disabled ? "停用" : "启用"}</td>
                  <td>
                    <div className={styles.actions}>
                      <Button size="sm" variant="quiet" disabled={!manageable && !(permissions.isSuper && state.me?.id === user.id)} onClick={() => openEdit(user)}>编辑</Button>
                      {permissions.isSuper ? <Button size="sm" variant="quiet" onClick={() => onOpenCredential({ mode: "view", user })}>密码</Button> : null}
                      <Button size="sm" variant="quiet" disabled={!manageable || protectedSuper} onClick={() => setConfirm({ kind: user.disabled ? "enable" : "disable", user })}>{user.disabled ? "启用" : "停用"}</Button>
                      <Button size="sm" variant="quiet" className={styles.dangerText} disabled={!manageable || protectedSuper} onClick={() => setConfirm({ kind: "delete", user })}>删除</Button>
                    </div>
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={4} className={styles.empty}>暂无可管理的账号</td></tr>}
          </tbody>
        </table>
      </div>

      <Drawer
        open={Boolean(account)}
        onOpenChange={(open) => { if (!open) setAccount(null); }}
        title={account?.mode === "create" ? "新增账号" : "编辑账号"}
        caption={account?.mode === "create" ? "创建后可作为开发人选择" : account?.user?.username}
      >
        {account ? (
          <form className={styles.dialogForm} onSubmit={(event) => { event.preventDefault(); void commitAccount(); }}>
            <div className={styles.field}>
              <label htmlFor="rsm-account-name">用户名</label>
              <input id="rsm-account-name" value={account.username} readOnly={account.mode === "edit"} onChange={(event) => setAccount({ ...account, username: event.target.value })} autoFocus />
            </div>
            <div className={styles.field}>
              <label htmlFor="rsm-account-role">角色</label>
              <select id="rsm-account-role" value={account.role} disabled={account.user?.role === "superadmin"} onChange={(event) => setAccount({ ...account, role: event.target.value })}>
                {roleOptions(account.user).map((role) => <option key={role} value={role}>{roleName(role)}</option>)}
              </select>
            </div>
            {account.mode === "create" || permissions.isSuper ? (
              <div className={styles.field}>
                <label htmlFor="rsm-account-password">{account.mode === "create" ? "初始密码（至少 1 个任意字符）" : "重设密码（留空则保留原密码）"}</label>
                <PasswordInput id="rsm-account-password" value={account.password} onChange={(value) => setAccount({ ...account, password: value })} autoComplete="new-password" />
              </div>
            ) : null}
            {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button onClick={() => setAccount(null)}>取消</Button>
              <Button type="submit" variant="primary" disabled={pending}>{pending ? "保存中…" : account.mode === "create" ? "创建账号" : "保存修改"}</Button>
            </div>
          </form>
        ) : null}
      </Drawer>

      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirm?.kind === "delete" ? "删除账号" : confirm?.kind === "disable" ? "停用账号" : "启用账号"}
        caption={confirm?.user.username}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button variant={confirm?.kind === "delete" ? "danger" : "primary"} onClick={() => confirm && void act(confirm.kind, confirm.user)}>{confirm?.kind === "delete" ? "确认删除" : confirm?.kind === "disable" ? "确认停用" : "确认启用"}</Button>
          </>
        }
      >
        <p style={{ color: "var(--rsm-muted)" }}>
          {confirm?.kind === "delete"
            ? `删除后该账号不能登录，关联的 ${state.requests.filter((row) => row.developer === confirm.user.id).length} 条需求及历史日志保留。`
            : confirm?.kind === "disable"
              ? "停用后立即退出登录，以游客身份只读访问；历史需求和日志保留，可随时重新启用。"
              : "重新启用后，该用户可以使用原账号登录。"}
        </p>
      </Dialog>
    </>
  );
}

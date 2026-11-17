import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Eye, EyeOff, X } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { api, ApiError } from "../../api/client";
import { createStateWriter } from "../../api/stateCache";
import type { User } from "../../api/types";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { Dialog } from "../../ui/Dialog";
import { PasswordInput } from "../../ui/PasswordInput";
import { useNotice } from "../../ui/Notice";
import { isValidPassword } from "../../lib/validation";
import { AuthCharacters } from "./AuthCharacters";
import styles from "./Auth.module.css";

function AuthBrand() {
  return (
    <div className={styles.brand} title="Request Schedule Manager">
      <CalendarRange aria-hidden="true" />
      <span className={styles.brandCopy}>
        <span>RSM</span>
        <small>Request Schedule Manager</small>
      </span>
    </div>
  );
}

function AuthShell({ children, onClose, attention = "idle", fullScreen = false }: {
  children: ReactNode;
  onClose?: () => void;
  attention?: "idle" | "typing" | "privacy";
  fullScreen?: boolean;
}) {
  return (
    <div className={`${styles.layer} ${fullScreen ? styles.setup : ""}`}>
      <aside className={styles.art} aria-label="RSM（Request Schedule Manager）">
        <AuthBrand />
        <div className={styles.artStage}>
          <AuthCharacters attention={attention} />
        </div>
        <p className={styles.artFooter}>排一排，更从容。</p>
      </aside>
      <section className={styles.content}>
        {onClose ? (
          <button type="button" className={styles.close} aria-label="关闭登录窗口" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        ) : null}
        <div className={styles.formPanel}>
          <div className={styles.mobileBrand}>
            <AuthBrand />
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

export function LoginDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const notice = useNotice();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState(true);
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);

  const changeOpen = (value: boolean) => {
    if (!value) {
      setPassword("");
      setVisible(false);
      setError("");
      setUsernameFocused(false);
      setPasswordFocused(false);
    }
    onOpenChange(value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim()) {
      setError("请填写用户名");
      return;
    }
    if (!password) {
      setError("请填写密码");
      return;
    }
    setPending(true);
    setError("");
    const writeState = createStateWriter(client, true);
    try {
      const state = await api.login(username.trim(), password, remember);
      if (!await writeState(state)) return;
      notice.notify(`欢迎回来，${state.me?.username ?? username}`);
      setPassword("");
      changeOpen(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "登录失败，请稍后重试");
    } finally {
      setPending(false);
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={changeOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content
          className={styles.modal}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            usernameInput.current?.focus();
          }}
        >
          <AuthShell
            onClose={() => changeOpen(false)}
            attention={visible && password ? "privacy" : usernameFocused ? "typing" : "idle"}
          >
            <RadixDialog.Title asChild>
              <span className="rsm-sr-only">登录 RSM</span>
            </RadixDialog.Title>
            <div className={styles.heading}>
              <h1>欢迎回来！</h1>
              <p>登录 RSM，继续与团队协作</p>
            </div>
            <form className={styles.form} onSubmit={submit} noValidate aria-busy={pending}>
              <div className={styles.field}>
                <label htmlFor="rsm-login-username">用户名</label>
                <input
                  ref={usernameInput}
                  id="rsm-login-username"
                  value={username}
                  placeholder={usernameFocused ? "" : "账号"}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "rsm-login-error" : undefined}
                  onFocus={() => setUsernameFocused(true)}
                  onBlur={() => setUsernameFocused(false)}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    setError("");
                  }}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-login-password">密码</label>
                <div
                  className={styles.passwordWrap}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setPasswordFocused(false);
                  }}
                >
                  <input
                    id="rsm-login-password"
                    type={visible ? "text" : "password"}
                    value={password}
                    placeholder={passwordFocused ? "" : "密码"}
                    autoComplete="current-password"
                    disabled={pending}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "rsm-login-error" : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError("");
                    }}
                  />
                  <button
                    type="button"
                    className={styles.passwordEye}
                    aria-label={visible ? "隐藏密码" : "显示密码"}
                    aria-pressed={visible}
                    disabled={pending}
                    onClick={() => setVisible((current) => !current)}
                  >
                    {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </div>
              </div>
              <div className={styles.options}>
                <Checkbox className={styles.remember} checked={remember} onCheckedChange={setRemember} label="保持登录状态" ariaLabel="保持登录状态" disabled={pending} />
                <span className={styles.help}>忘记密码请联系管理员</span>
              </div>
              {error ? <p id="rsm-login-error" className={styles.error} role="alert">{error}</p> : null}
              <button type="submit" className={styles.submit} disabled={pending}>{pending ? "登录中…" : "登录"}</button>
            </form>
            <button type="button" className={`${styles.submit} ${styles.guest}`} onClick={() => changeOpen(false)}>以游客身份浏览</button>
          </AuthShell>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function SetupScreen() {
  const client = useQueryClient();
  const notice = useNotice();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidPassword(password)) {
      setError("密码至少 1 个字符");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setPending(true);
    setError("");
    const writeState = createStateWriter(client, true);
    try {
      const state = await api.setup(password);
      if (!await writeState(state)) return;
      notice.notify("初始超级管理员密码已设置");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "设置失败，请稍后重试");
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell fullScreen attention={(passwordVisible && password) || (confirmVisible && confirm) ? "privacy" : "idle"}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.heading}>
          <h2>首次使用 RSM</h2>
          <p>设置超级管理员「张金科」的登录密码，之后可登录并添加其他成员。</p>
        </div>
        <div className={styles.field}>
          <label>用户名</label>
          <input value="张金科" readOnly aria-readonly="true" />
        </div>
        <div className={styles.field}>
          <label htmlFor="rsm-setup-password">密码（至少 1 个任意字符）</label>
          <PasswordInput id="rsm-setup-password" value={password} onChange={(value) => { setPassword(value); setError(""); }} onVisibilityChange={setPasswordVisible} autoComplete="new-password" labelText="初始密码" />
        </div>
        <div className={styles.field}>
          <label htmlFor="rsm-setup-confirm">确认密码</label>
          <PasswordInput id="rsm-setup-confirm" value={confirm} onChange={(value) => { setConfirm(value); setError(""); }} onVisibilityChange={setConfirmVisible} autoComplete="new-password" labelText="确认密码" />
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <Button type="submit" variant="primary" className={styles.submit} disabled={pending}>{pending ? "设置中…" : "设置密码并进入"}</Button>
        <p className={styles.note}>请牢记密码；超级管理员可在成员管理中查看和重设密码。</p>
      </form>
    </AuthShell>
  );
}

export type PasswordMode = "self" | "reset" | "view";

export function PasswordDialog({ open, onOpenChange, mode, user }: { open: boolean; onOpenChange: (open: boolean) => void; mode: PasswordMode; user?: User | null }) {
  const client = useQueryClient();
  const notice = useNotice();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [revealed, setRevealed] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const title = mode === "self" ? "修改密码" : mode === "reset" ? "重设密码" : "查看密码";
  const caption = user ? user.username : "本人";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode === "view") {
      setPending(true);
      try {
        const result = await api.revealPassword(user?.id ?? "");
        setRevealed(result.password);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : "读取失败");
      } finally {
        setPending(false);
      }
      return;
    }
    if (!isValidPassword(next)) {
      setError("新密码至少 1 个字符");
      return;
    }
    if (mode === "self" && !current) {
      setError("请填写当前密码");
      return;
    }
    setPending(true);
    const writeState = createStateWriter(client, mode === "self");
    try {
      if (mode === "self") {
        const state = await api.changePassword(current, next);
        if (!await writeState(state)) return;
        notice.notify("密码已更新");
      } else if (user) {
        const state = await api.updateUser(user.id, { password: next });
        if (!await writeState(state)) return;
        notice.notify(`已重设 ${user.username} 的密码`);
      }
      setCurrent("");
      setNext("");
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "操作失败");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) { setRevealed(""); setError(""); setCurrent(""); setNext(""); } onOpenChange(value); }} title={title} caption={caption} width={360}>
      <form onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }}>
        {mode === "view" ? (
          revealed ? (
            <div className={styles.field}>
              <label>已保存密码</label>
              <input value={revealed} readOnly aria-label="已保存密码" />
            </div>
          ) : (
            <p className={styles.note}>点击下方按钮查看该账号的密码。</p>
          )
        ) : null}
        {mode === "self" ? (
          <div className={styles.field}>
            <label htmlFor="rsm-pw-current">当前密码</label>
            <PasswordInput id="rsm-pw-current" value={current} onChange={setCurrent} autoComplete="current-password" />
          </div>
        ) : null}
        {mode !== "view" ? (
          <div className={styles.field}>
            <label htmlFor="rsm-pw-next">新密码（至少 1 个任意字符）</label>
            <PasswordInput id="rsm-pw-next" value={next} onChange={setNext} autoComplete="new-password" />
          </div>
        ) : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="submit" variant="primary" disabled={pending}>{mode === "view" ? (revealed ? "已读取" : pending ? "读取中…" : "查看密码") : pending ? "保存中…" : "保存"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

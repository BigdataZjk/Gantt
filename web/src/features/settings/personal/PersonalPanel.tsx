import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, Upload } from "lucide-react";
import { api, ApiError } from "../../../api/client";
import { STATE_KEY } from "../../../api/hooks";
import type { State, User } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { useNotice } from "../../../ui/Notice";
import { Avatar } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { DomainTag, PriorityTag } from "../../../ui/Tag";
import { EnumSelect } from "../../../ui/EnumSelect";
import { DomainColorDialog } from "../DomainColorDialog";
import type { RequestPermissions } from "../../requests/types";
import styles from "../Settings.module.css";

interface Props {
  state: State;
  permissions: RequestPermissions;
  onLogin: () => void;
  onLogout: () => void;
  onOpenCredential: (action: { mode: "self" | "reset" | "view"; user?: User | null }) => void;
}

const DENSITIES: { value: "compact" | "comfortable"; label: string }[] = [
  { value: "compact", label: "紧凑" },
  { value: "comfortable", label: "舒适" },
];

export function PersonalPanel({ state, onLogin, onLogout, onOpenCredential }: Props) {
  const { prefs, domainColor, update } = usePreferences();
  const client = useQueryClient();
  const notice = useNotice();
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState("");
  const [colorDomain, setColorDomain] = useState<string | null>(null);
  const me = state.me;

  const upload = async (file: File) => {
    setAvatarError("");
    const gif = file.type === "image/gif" || (!file.type && /\.gif$/i.test(file.name));
    if (!gif && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setAvatarError("请选择 JPG、PNG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setAvatarError("请选择 4 MiB 以内的图片");
      return;
    }
    try {
      const state = await api.uploadAvatar(file);
      client.setQueryData(STATE_KEY, state);
      notice.notify("头像已更新");
    } catch (error) {
      setAvatarError(error instanceof ApiError ? error.message : "头像上传失败");
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>个性化</h2>
          <p className={styles.caption}>仅影响你自己的界面，其他成员看到的共享需求数据不受影响。</p>
        </div>
      </div>

      <div className={styles.personalScroll} data-scroll-container="personal-content">
        <div className={styles.personalSettings}>
          <section className={styles.personalRow} aria-label="头像">
            <div className={styles.personalLabel}>
              <h3>头像</h3>
              <p>支持 JPG、PNG、WebP 和 GIF，最大 4 MiB，GIF 保留动画。</p>
            </div>
            <div className={styles.personalControls}>
              <div className={styles.avatarRow}>
                <div className={styles.avatarIdentity}>
                  <Avatar name={me?.username ?? "游客"} avatar={me?.avatar} size="large" />
                  <div className={styles.avatarSummary}>
                    <span>{me?.username ?? "游客"}</span>
                    {!me ? <p className={styles.captionSmall}>登录后可设置头像</p> : null}
                  </div>
                </div>
                <Button size="sm" disabled={!me} onClick={() => fileRef.current?.click()}>
                  <Upload aria-hidden="true" />
                  上传头像
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,.gif"
                hidden
                disabled={!me}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = "";
                }}
              />
              {avatarError ? <p className={styles.uploadError} role="alert">{avatarError}</p> : null}
            </div>
          </section>

          <section className={styles.personalRow} aria-label="新增需求默认值">
            <div className={styles.personalLabel}>
              <h3>新增需求默认值</h3>
              <p>自动保存，仅用于新草稿，已填写的内容会保留。</p>
            </div>
            <div className={`${styles.personalControls} ${styles.grid2}`}>
              <div className={styles.field}>
                <span className={styles.caption}>默认需求类型</span>
                <EnumSelect
                  ariaLabel="默认需求类型"
                  value={prefs.defaultRequestType}
                  options={["常规需求", "数据需求"].map((value) => ({ value, label: value }))}
                  onChange={(value) => update({ defaultRequestType: value })}
                  disabled={!me}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.caption}>默认优先级</span>
                <EnumSelect
                  ariaLabel="默认优先级"
                  value={prefs.defaultPriority}
                  options={["P0", "P1", "P2"].map((value) => ({ value, label: value }))}
                  onChange={(value) => update({ defaultPriority: value })}
                  disabled={!me}
                  renderValue={(value) => <PriorityTag value={value} />}
                  renderOption={(option) => <PriorityTag value={option.value} />}
                />
              </div>
            </div>
          </section>

          <section className={styles.personalRow} aria-label="个人业务域配色">
            <div className={styles.personalLabel}>
              <h3>个人业务域配色</h3>
              <p>仅对自己生效，优先于全局默认色。</p>
            </div>
            <div className={`${styles.personalControls} ${styles.domainPalette}`}>
              {state.domains.map((domain) => {
                const overridden = Boolean(prefs.domainColors[domain.name]);
                return (
                  <div key={domain.id} className={styles.domainItem}>
                    <button
                      type="button"
                      className={styles.swatch}
                      style={{ background: domainColor(domain.name, state.domains) }}
                      aria-label={`双击设置${domain.name}个人配色`}
                      data-tooltip={me ? "双击设置个人配色" : "登录后可自定义配色"}
                      disabled={!me}
                      onDoubleClick={() => setColorDomain(domain.name)}
                    />
                    <div className={styles.domainMeta}>
                      <DomainTag name={domain.name} color={domainColor(domain.name, state.domains)} />
                      <span className={styles.captionSmall}>{overridden ? "已自定义" : "使用全局默认色"}</span>
                      <button
                        type="button"
                        className={styles.colorReset}
                        disabled={!me || !overridden}
                        onClick={() => {
                          const next = { ...prefs.domainColors };
                          delete next[domain.name];
                          update({ domainColors: next });
                        }}
                      >
                        恢复默认色
                      </button>
                    </div>
                  </div>
                );
              })}
              {!state.domains.length ? <span className={styles.caption}>暂无业务域</span> : null}
            </div>
          </section>

          <section className={styles.personalRow} aria-label="表格密度">
            <div className={styles.personalLabel}>
              <h3>表格密度</h3>
              <p>调整需求列表与甘特图的行间距。</p>
            </div>
            <div className={styles.personalControls}>
              <div className={styles.densityOptions}>
                {DENSITIES.map((item) => (
                  <Button
                    key={item.value}
                    size="sm"
                    variant="quiet"
                    className={styles.densityOption}
                    aria-pressed={prefs.density === item.value}
                    disabled={!me}
                    onClick={() => update({ density: item.value })}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          </section>

          <section className={styles.personalRow} aria-label="账号安全">
            <div className={styles.personalLabel}>
              <h3>账号安全</h3>
              <p>密码至少 1 个任意字符。超级管理员可查看和重设任意账号密码。</p>
            </div>
            <div className={`${styles.personalControls} ${styles.inline}`}>
              {me ? (
                <>
                  <Button size="sm" onClick={() => onOpenCredential({ mode: "self", user: me })}>修改密码</Button>
                  <Button size="sm" variant="quiet" onClick={onLogout}><LogOut aria-hidden="true" />退出登录</Button>
                </>
              ) : (
                <Button size="sm" onClick={onLogin}><LogIn aria-hidden="true" />登录</Button>
              )}
            </div>
          </section>
        </div>
      </div>

      <DomainColorDialog
        open={Boolean(colorDomain)}
        title={colorDomain ? `${colorDomain}个人配色` : ""}
        caption="仅对自己生效，优先于全局默认色"
        initialColor={colorDomain ? domainColor(colorDomain, state.domains) : "#3b82f6"}
        onOpenChange={(open) => { if (!open) setColorDomain(null); }}
        onSave={async (color) => {
          if (!colorDomain) return false;
          update({ domainColors: { ...prefs.domainColors, [colorDomain]: color } });
          notice.notify("个人配色已保存");
          return true;
        }}
      />
    </>
  );
}

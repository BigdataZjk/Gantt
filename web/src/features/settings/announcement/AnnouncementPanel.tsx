import { useState, type FormEvent } from "react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import { Button } from "../../../ui/Button";
import { useNotice } from "../../../ui/Notice";
import styles from "../Settings.module.css";

export function AnnouncementPanel({ announcement }: { announcement: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = useMutationRunner();
  const notice = useNotice();
  const text = (draft ?? announcement).trim();
  const canSave = !pending && Boolean(text) && text !== announcement;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    setPending(true);
    try {
      if (await run((base) => api.saveAnnouncement(base, text))) {
        setDraft(null);
        notice.notify("公告已更新");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.personalScroll}>
      <form className={`${styles.personalSettings} ${styles.announcementForm}`} onSubmit={save}>
        <div className={styles.field}>
          <label htmlFor="announcement-text">公告内容</label>
          <textarea
            id="announcement-text"
            rows={5}
            value={draft ?? announcement}
            onChange={(event) => setDraft(event.target.value)}
            disabled={pending}
            aria-describedby="announcement-help"
            required
          />
          <p id="announcement-help" className={styles.caption}>公告显示在需求页顶部。添加文字链接可写为 <code>[查看排期说明](https://example.com/guide)</code>。</p>
        </div>
        <Button type="submit" variant="primary" disabled={!canSave}>{pending ? "保存中…" : "保存公告"}</Button>
      </form>
    </div>
  );
}

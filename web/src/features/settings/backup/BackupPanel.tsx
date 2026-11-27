import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download } from "lucide-react";
import { api, type BackupInfo } from "../../../api/client";
import { timeLabel } from "../../../lib/dates";
import { Button } from "../../../ui/Button";
import styles from "../Settings.module.css";

export function BackupPanel() {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<BackupInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => () => active.current?.abort(), []);

  const download = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setResult(null);
    setError("");
    try {
      const { blob, ...backup } = await api.downloadBackup(controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backup.filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setResult(backup);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "备份下载失败，请重试");
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <section className={`${styles.personalSettings} ${styles.maintenanceCard}`} aria-labelledby="backup-heading">
      <div className={styles.maintenanceCardHeader}>
        <div className={styles.maintenanceCardHeading}>
          <h2 id="backup-heading" className={styles.sectionTitle}>实例备份</h2>
          <p className={styles.caption}>ZIP 包含需求（含归档）、排期、账号和恢复密钥，请妥善保管。</p>
        </div>
        <Button variant="primary" disabled={pending} onClick={() => void download()}>
          <Download aria-hidden="true" />{pending ? "正在生成并校验…" : "生成并下载备份"}
        </Button>
      </div>
      {error ? <p className={styles.uploadError} role="alert">{error}</p> : null}
      {result ? (
        <div className={styles.backupResult} role="status">
          <div className={styles.backupStatus}><CheckCircle2 aria-hidden="true" />校验通过，已开始下载</div>
          <p className={styles.backupFile}>{result.filename}</p>
          <p className={styles.caption}>北京时间 <time dateTime={result.createdAt}>{timeLabel(result.createdAt)}</time> · 数据修订号 {result.revision}</p>
        </div>
      ) : null}
    </section>
  );
}

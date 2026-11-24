import { ChevronDown } from "lucide-react";
import { releaseNotes } from "./releaseNotes";
import styles from "./UpdatesPanel.module.css";

const categories = [
  { key: "added", label: "新增" },
  { key: "improved", label: "优化" },
  { key: "fixed", label: "修复" },
] as const;

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" });

export function UpdatesPanel({ serverVersion }: { serverVersion?: string }) {
  const currentVersion = serverVersion?.match(/^v?(\d+\.\d+\.\d+)(?=$|[-+])/)?.[1];
  const entries = Object.entries(releaseNotes)
    .filter(([version]) => !currentVersion || version.localeCompare(currentVersion, "en", { numeric: true }) <= 0)
    .sort(([a], [b]) => b.localeCompare(a, "en", { numeric: true }));

  return (
    <section className={styles.scroll} aria-labelledby="rsm-updates-heading" data-scroll-container="update-history">
      <div className={styles.content}>
        <h2 id="rsm-updates-heading" className={styles.title}>更新日志</h2>
        <ol className={styles.timeline} aria-label="版本时间轴" role="list">
          {entries.map(([version, note], index) => (
            <li key={version} className={styles.node} data-current={version === currentVersion || undefined}>
              <time className={styles.date} dateTime={note.date}>
                <span>{dateFormatter.format(new Date(note.date))}</span>
                <span className={styles.year}>{note.date.slice(0, 4)}</span>
              </time>
              <details className={styles.card} open={index === 0}>
                <summary className={styles.header}>
                  <h3 className={styles.heading}>
                    <span className={styles.versionMeta}>
                      <span className={styles.version} aria-current={version === currentVersion ? "true" : undefined}>v{version}</span>
                      {version === currentVersion ? <span className={styles.current}>当前版本</span> : null}
                    </span>
                    <span className={styles.noteTitle}>{note.title}</span>
                    <ChevronDown className={styles.chevron} aria-hidden="true" />
                  </h3>
                </summary>
                <div className={styles.changes}>
                  {categories.map(({ key, label }) => note[key]?.length ? (
                    <div key={key} className={styles.category}>
                      <h4 className={styles.categoryLabel} data-kind={key}>{label}</h4>
                      <ul className={styles.entries} role="list">
                        {note[key].map(({ title, description }) => (
                          <li key={title} className={styles.change}>
                            <strong>{title}</strong>
                            <p>{description}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null)}
                </div>
              </details>
            </li>
          ))}
        </ol>
        {!entries.length ? <p className={styles.empty}>暂无此版本的更新日志</p> : null}
      </div>
    </section>
  );
}

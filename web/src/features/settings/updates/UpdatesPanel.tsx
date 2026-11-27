import { useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { releaseNotes } from "./releaseNotes";
import styles from "./UpdatesPanel.module.css";

const categories = [
  { key: "added", label: "新增" },
  { key: "improved", label: "优化" },
  { key: "fixed", label: "修复" },
] as const;

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" });
const versionOrder = new Intl.Collator("en", { numeric: true });
const releaseEntries = Object.entries(releaseNotes).sort(([a], [b]) => versionOrder.compare(b, a));

function normalizeSearch(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

export function UpdatesPanel({ serverVersion }: { serverVersion?: string }) {
  const [query, setQuery] = useState("");
  const [historyExpansion, setHistoryExpansion] = useState<Record<string, boolean>>({});
  const [searchExpansion, setSearchExpansion] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keywords = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const searching = keywords.length > 0;
  const expansion = searching ? searchExpansion : historyExpansion;
  const setExpansion = searching ? setSearchExpansion : setHistoryExpansion;

  function updateSearch(value: string) {
    setQuery(value);
    setSearchExpansion({});
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  const currentVersion = serverVersion?.match(/^v?(\d+\.\d+\.\d+)(?=$|[-+])/)?.[1];
  const visibleEntries = releaseEntries.filter(([version]) => !currentVersion || versionOrder.compare(version, currentVersion) <= 0);
  const latestVersion = visibleEntries[0]?.[0];
  const entries = visibleEntries.flatMap(([version, note]) => {
    const sections = categories.flatMap((category) => {
      const items = note[category.key];
      const changes = searching ? items?.filter(({ title, description }) => {
        const text = normalizeSearch(`${title} ${description}`);
        return keywords.every((keyword) => text.includes(keyword));
      }) : items;
      return changes?.length ? [{ ...category, changes }] : [];
    });
    return searching && !sections.length ? [] : [{ version, note, sections }];
  });
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const [major] = entry.version.split(".", 1);
    const group = groups.get(major);
    if (group) group.push(entry);
    else groups.set(major, [entry]);
  }

  return (
    <section className={styles.panel} aria-labelledby="rsm-updates-heading">
      <header className={styles.toolbar}>
        <div className={styles.toolbarContent}>
          <h2 id="rsm-updates-heading" className={styles.title}>更新日志</h2>
          <div className={styles.search} role="search" aria-label="更新日志">
            <Search className={styles.searchIcon} aria-hidden="true" />
            <input
              ref={searchRef}
              className={styles.searchInput}
              type="search"
              aria-label="搜索更新日志"
              placeholder="搜索更新日志"
              value={query}
              onChange={({ currentTarget }) => updateSearch(currentTarget.value)}
            />
            {query ? (
              <button
                type="button"
                className={styles.clearSearch}
                aria-label="清空搜索"
                onClick={() => {
                  updateSearch("");
                  searchRef.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <div ref={scrollRef} className={styles.scroll} data-scroll-container="update-history">
        <div className={styles.content}>
          {Array.from(groups, ([major, versions]) => (
            <section key={major} className={styles.group} aria-labelledby={`rsm-updates-major-${major}`}>
              <h3 id={`rsm-updates-major-${major}`} className={styles.groupHeading}>
                <span className={styles.majorVersion}>V{major}</span>
              </h3>
              <ol className={styles.timeline} aria-label="版本时间轴" role="list">
                {versions.map(({ version, note, sections }) => {
                  const current = version === currentVersion;
                  const open = expansion[version] ?? (searching || version === latestVersion);
                  return (
                    <li key={version} className={styles.node} data-current={current || undefined}>
                      <time className={styles.date} dateTime={note.date}>
                        <span>{dateFormatter.format(new Date(note.date))}</span>
                        <span className={styles.year}>{note.date.slice(0, 4)}</span>
                      </time>
                      <details className={styles.card} open={open}>
                        <summary className={styles.header} onClick={(event) => {
                          event.preventDefault();
                          setExpansion((previous) => ({ ...previous, [version]: !open }));
                        }}>
                          <h4 className={styles.heading}>
                            <span className={styles.versionMeta}>
                              <span className={styles.version} aria-current={current ? "true" : undefined}>v{version}</span>
                              {current ? <span className={styles.current}>当前版本</span> : null}
                            </span>
                            <span className={styles.noteTitle}>{note.title}</span>
                            <ChevronDown className={styles.chevron} aria-hidden="true" />
                          </h4>
                        </summary>
                        <div className={styles.changes}>
                          {sections.map(({ key, label, changes }) => (
                            <div key={key} className={styles.category}>
                              <h5 className={styles.categoryLabel} data-kind={key}>{label}</h5>
                              <ul className={styles.entries} role="list">
                                {changes.map(({ title, description }) => (
                                  <li key={title} className={styles.change}>
                                    <strong>{title}</strong>
                                    <p>{description}</p>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {!entries.length ? (
            <p className={styles.empty} role="status">{searching ? "没有匹配的更新记录" : "暂无此版本的更新日志"}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

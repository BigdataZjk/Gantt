import { useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import type { State } from "../../../api/types";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import { timeLabel } from "../../../lib/dates";
import { Button } from "../../../ui/Button";
import { useNotice } from "../../../ui/Notice";
import { YearSelect } from "./YearSelect";
import styles from "../Settings.module.css";
import local from "./CalendarPanel.module.css";

export function CalendarPanel({ state }: { state: State }) {
  const [year, setYear] = useState(() => new Date().getFullYear() + 1);
  const [pending, setPending] = useState(false);
  const [candidate, setCandidate] = useState<{ data: Record<string, unknown>; name: string; count: number } | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const runner = useMutationRunner();
  const notice = useNotice();
  const calendar = state.calendar;
  const edition = calendar.editions?.find((item) => item.year === year);
  const covered = calendar.years.includes(year);
  const days = edition?.days ?? [
    ...calendar.restDays.filter((date) => date.startsWith(String(year))).map((date) => ({ date, name: "法定节假日", isOffDay: true })),
    ...calendar.workDays.filter((date) => date.startsWith(String(year))).map((date) => ({ date, name: "调休上班", isOffDay: false })),
  ];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const validYear = Number.isInteger(year) && year >= 2000 && year <= 2099;

  const update = async (source: "online" | "file") => {
    if (pending || !validYear || source === "file" && !candidate) return;
    setPending(true);
    setError("");
    try {
      const result = await runner((base) => source === "online" ? api.refreshCalendar(base, year) : api.importCalendar(base, year, candidate!.data));
      if (result) {
        setCandidate(null);
        notice.notify(`${year} 年日历已更新，既有需求日期保持不变`);
      }
    } finally { setPending(false); }
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setCandidate(null);
    setError("");
    try {
      if (file.size > 256 * 1024) throw new Error("日历 JSON 不能超过 256 KB");
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      if (!data || typeof data !== "object" || data.year !== year || !Array.isArray(data.days) || !data.days.length) throw new Error("请选择与当前年份一致且含放假安排的 holiday-cn JSON");
      setCandidate({ data, name: file.name, count: data.days.length });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取日历文件"); }
    finally { if (input.current) input.current.value = ""; }
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ year, papers: edition?.papers ?? [], days: sorted }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${year}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={local.page} data-scroll-container="calendar-content">
      <div className={styles.toolbar}>
        <div className={styles.inline}>
          <label htmlFor="calendar-year">日历年份</label>
          <YearSelect value={year} coveredYears={calendar.years} disabled={pending} onChange={(next) => { setYear(next); setCandidate(null); setError(""); }} />
          <span className={covered ? local.covered : local.uncovered}>{covered ? "已覆盖" : "未覆盖"}</span>
        </div>
        <div className={styles.actions}>
          <Button disabled={pending || !validYear} onClick={() => void update("online")}><RefreshCw aria-hidden="true" />{pending ? "正在更新…" : "刷新公开日历"}</Button>
          <Button disabled={pending || !validYear} onClick={() => input.current?.click()}><Upload aria-hidden="true" />导入 JSON</Button>
          <Button disabled={pending || !days.length} onClick={exportJSON}><Download aria-hidden="true" />导出</Button>
          <input ref={input} type="file" accept=".json,application/json" hidden aria-label="选择日历 JSON" onChange={(event) => void chooseFile(event.target.files?.[0])} />
        </div>
      </div>
      <div className={local.info}>
        <div><strong>中国大陆工作日历</strong><span>已覆盖 {calendar.years.join("、")} 年 · {edition?.updatedAt ? `更新于 ${timeLabel(edition.updatedAt)}` : "内置已公布安排"}</span></div>
        <p>节假日与调休用于甘特图、人天及交付日期计算。按年度替换，其他年份保留，既有需求日期不会自动移动。</p>
        <p>公开数据：<a href="https://github.com/NateScarlet/holiday-cn" target="_blank" rel="noreferrer">holiday-cn</a>（JSON / ICS）。{edition?.source ? `当前来源：${edition.source}。` : ""}{edition?.papers.map((paper, index) => <a key={paper} href={paper} target="_blank" rel="noreferrer">公告{index + 1}</a>)}</p>
        {!covered ? <p className={local.uncovered}>该年尚未覆盖，暂按普通周末计算；未公布或刷新失败时保留现有日历。</p> : null}
      </div>
      {candidate ? <div className={local.importPreview} role="status"><span>{candidate.name} · {candidate.count} 条日期安排，将替换 {year} 年日历。</span><Button variant="primary" disabled={pending} onClick={() => void update("file")}>应用导入</Button><Button disabled={pending} onClick={() => setCandidate(null)}>取消</Button></div> : null}
      {error ? <p role="alert" className={styles.uploadError}>{error}</p> : null}
      <div className={`${styles.tableWrap} ${local.tableViewport}`}>
        <table className={styles.table} aria-label={`${year} 年节假日及调休`}>
          <thead><tr><th>日期</th><th>安排</th><th>节日</th></tr></thead>
          <tbody>{sorted.length ? sorted.map((day) => <tr key={day.date}><td>{day.date}</td><td><span className={day.isOffDay ? local.rest : local.work}>{day.isOffDay ? "放假" : "调休上班"}</span></td><td>{day.name}</td></tr>) : <tr><td colSpan={3} className={styles.empty}>尚无该年节假日安排，请刷新公开日历或导入 JSON。</td></tr>}</tbody>
        </table>
      </div>
      <div className={local.footer}>{year} 年 · 放假 {days.filter((day) => day.isOffDay).length} 天 · 调休上班 {days.filter((day) => !day.isOffDay).length} 天<span>普通周末自动计算</span></div>
    </div>
  );
}

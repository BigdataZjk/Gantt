import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CirclePause } from "lucide-react";
import type { ApiRequest, Calendar, User } from "../../../api/types";
import { addDays, diffDays, enumerateDates, isWorkday } from "../../../lib/dates";
import { PriorityTag } from "../../../ui/Tag";
import { dayResolver, groupRequests, planOf, segmentFillBounds, workingHoldGaps, type SequencePlan } from "./ganttMath";
import { sequencePreviewRows, type SequencePreviewRow } from "./sequencePreviewModel";
import styles from "./SequencePreview.module.css";

interface Props {
  requests: ApiRequest[];
  users: User[];
  calendar: Calendar;
  sequence: SequencePlan;
  colorFor: (domain: string) => string;
}

export function SequencePreview({ requests, users, calendar, sequence, colorFor }: Props) {
  const model = useMemo(() => sequencePreviewRows(requests, sequence, calendar), [requests, sequence, calendar]);
  const entries = new Map(model.rows.map((row) => [row.after.id, row]));
  const groups = groupRequests(model.rows.map((row) => row.after), users, calendar, {}).filter((group) => group.rows.length);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setWidth(Math.max(420, element.clientWidth - 220));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const dayWidth = width / Math.max(1, model.days);
  const ticks = useMemo(() => {
    if (!model.days) return [];
    const spacing = Math.max(1, Math.ceil(model.days * 36 / width));
    const step = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365].find((candidate) => candidate >= spacing) ?? spacing;
    return Array.from({ length: Math.ceil(model.days / step) }, (_, index) => ({ date: addDays(model.start, index * step), offset: index * step }));
  }, [model.days, model.start, width]);
  const restDates = useMemo(() => dayWidth >= 4 ? enumerateDates(model.start, model.end).filter((date) => !isWorkday(date, calendar)) : [], [dayWidth, model.start, model.end, calendar]);
  const position = (start: string, end = start): CSSProperties => ({
    left: `${diffDays(model.start, start) / model.days * 100}%`,
    width: `${(diffDays(start, end) + 1) / model.days * 100}%`,
  });
  const skipped = model.rows.filter((row) => row.selected && (!row.after.developer || !planOf(row.after, calendar).segments.length));

  return (
    <div className={styles.preview} data-sequence-preview>
      <div className={styles.overview}>
        <div>
          <strong>排期关系</strong>
          <span>{model.days ? `${model.start} — ${model.end} · ${model.days} 天` : "选中需求暂无开发排期"}</span>
        </div>
        <div className={styles.legend} aria-label="预览图例">
          <span><i className={styles.beforeKey} />原排期</span>
          <span><i className={styles.afterKey} />顺排后</span>
        </div>
      </div>
      <div ref={viewport} className={styles.viewport} data-scroll-container="sequence-preview">
        <table className={styles.chart} aria-label="顺排甘特预览" data-start={model.start} data-end={model.end} style={{ "--sequence-day-width": `${100 / Math.max(1, model.days)}%`, "--sequence-grid-step": dayWidth >= 4 ? 1 : Math.max(1, Math.ceil(24 / dayWidth)) } as CSSProperties}>
          <colgroup><col className={styles.nameColumn} /><col /></colgroup>
          <thead>
            <tr>
              <th scope="col" className={styles.nameHead}>需求 / 开发人</th>
              <th scope="col" className={styles.axisHead}>
                <div className={styles.axis} aria-label={model.days ? `${model.start} 至 ${model.end}` : "无排期"}>
                  {ticks.map((tick) => <span key={tick.date} style={{ left: `${(tick.offset + 0.5) / model.days * 100}%` }} data-tooltip={tick.date}>{model.days > 45 || tick.offset === 0 || tick.date.endsWith("-01") ? tick.date.slice(5).replace("-", "/") : Number(tick.date.slice(-2))}</span>)}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((group) => group.rows.map((request) => {
              const entry = entries.get(request.id)!;
              return (
                <tr key={request.id} data-preview-row={request.id} data-preview-selected={entry.selected}>
                  <th scope="row" className={styles.nameCell}>
                    <div className={styles.name}><PriorityTag value={request.priority} /><span data-tooltip={request.name}>{request.name}</span></div>
                    <div className={styles.meta}><span>{group.name}</span><span className={!entry.selected ? styles.follow : ""}>{!entry.selected ? "随动" : !request.developer ? "未分配" : !planOf(request, calendar).segments.length ? "未排期" : entry.changed ? "调整" : "保持"}</span></div>
                  </th>
                  <td className={styles.timelineCell} style={{ "--preview-fill": colorFor(request.domain) } as CSSProperties}>
                    <div className={styles.track}>
                      {restDates.map((date) => <span key={date} className={styles.rest} style={position(date)} aria-hidden="true" />)}
                      {model.days ? <PreviewBars entry={entry} calendar={calendar} rangeStart={model.start} rangeDays={model.days} dayWidth={dayWidth} /> : null}
                      {!planOf(request, calendar).segments.length ? <span className={styles.noPlan}>暂无排期</span> : null}
                    </div>
                  </td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
      {skipped.length ? <p className={styles.note}>未排期或未分配开发人的 {skipped.length} 项仅供参照，不参与顺排。</p> : null}
      {!sequence.changes.length ? <p className={styles.note}>当前排期无需移动。</p> : null}
    </div>
  );
}

function PreviewBars({ entry, calendar, rangeStart, rangeDays, dayWidth }: { entry: SequencePreviewRow; calendar: Calendar; rangeStart: string; rangeDays: number; dayWidth: number }) {
  return (["before", "after"] as const).map((kind) => {
    const request = entry[kind];
    const plan = planOf(request, calendar);
    const bounds = segmentFillBounds(request, calendar);
    const resolve = dayResolver(request, calendar);
    const left = (date: string) => diffDays(rangeStart, date) / rangeDays * 100;
    return (
      <div key={kind} className={kind === "before" ? styles.beforeLane : styles.afterLane} aria-label={kind === "before" ? "原排期" : "顺排后"}>
        {workingHoldGaps(request, calendar).map((gap) => (
          <span key={gap.start} className={styles.hold} style={{ left: `${left(gap.start)}%`, width: `${(diffDays(gap.start, gap.end) + 1) / rangeDays * 100}%` }} data-tooltip={`${kind === "before" ? "原排期" : "顺排后"} HOLD：${gap.start} — ${gap.end}`}>
            {kind === "after" && (diffDays(gap.start, gap.end) + 1) * dayWidth >= 16 ? <CirclePause aria-hidden="true" /> : null}
          </span>
        ))}
        {plan.segments.map((segment, index) => {
          const fill = bounds[index];
          if (!fill) return null;
          const duration = diffDays(fill.start, fill.end) + 1;
          const inactive = kind === "after" && dayWidth >= 4 ? enumerateDates(fill.start, fill.end).filter((date) => !resolve(date).active) : [];
          return (
            <span key={index} className={styles.bar} data-preview-bar={kind} data-phase={index} data-start={segment.start} data-end={segment.end} style={{ left: `${left(fill.start)}%`, width: `${duration / rangeDays * 100}%` }} data-tooltip={`${request.name} · ${kind === "before" ? "原排期" : "顺排后"}：${segment.start} — ${segment.end}`}>
              {inactive.map((date) => <i key={date} className={styles.inactive} style={{ left: `${diffDays(fill.start, date) / duration * 100}%`, width: `${100 / duration}%` }} />)}
            </span>
          );
        })}
      </div>
    );
  });
}

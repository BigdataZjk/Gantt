import type { State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { addDays } from "../../../lib/dates";
import { formatDays } from "../../../lib/format";
import { Drawer } from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { CopyLinkButton } from "../../../ui/CopyLinkButton";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../../ui/Tag";
import { deliveryOf } from "../filtering";
import { planOf, workingHoldGaps } from "../gantt/ganttMath";
import { segmentDays } from "../../../schedule";
import styles from "./RequestDetailsDrawer.module.css";

export function RequestDetailsDrawer({ state, id, onClose }: { state: State; id: number | null; onClose: () => void }) {
  const { domainColor } = usePreferences();
  const request = id !== null ? state.requests.find((row) => row.id === id) : undefined;
  const calendar = state.calendar;
  const plan = request ? planOf(request, calendar) : null;
  const holds = request ? workingHoldGaps(request, calendar) : [];
  const marks = request
    ? [
        ...(request.vacation ?? []).map((date) => ({ date, label: "休假" })),
        ...(request.overtime ?? []).map((date) => ({ date, label: "加班" })),
      ].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  return (
    <Drawer open={Boolean(request)} onOpenChange={(open) => { if (!open) onClose(); }} title="需求详情" caption={request ? request.archived ? "已归档 · 只读" : "只读查看" : undefined} footer={<Button onClick={onClose}>关闭</Button>}>
      {request ? (
        <div className={styles.details}>
          <section className={styles.section} aria-label="基本信息">
            <h4>基本信息</h4>
            <dl className={styles.grid}>
              <div className={`${styles.field} ${styles.wide}`}>
                <dt>需求名</dt>
                <dd>
                  <span className={styles.name}>
                    <span className={styles.nameText}>{request.name}</span>
                    <PriorityTag value={request.priority} />
                    <StatusTag value={request.status} />
                  </span>
                </dd>
              </div>
              <div className={styles.field}><dt>提需人</dt><dd>{request.requester || "-"}</dd></div>
              <div className={styles.field}><dt>提需日期</dt><dd>{request.requestedAt || "-"}</dd></div>
              <div className={`${styles.field} ${styles.wide}`}><dt>PRD 链接</dt><dd><ReadonlyLink label="PRD 链接" value={request.prd} /></dd></div>
            </dl>
          </section>
          <section className={styles.section} aria-label="开发信息">
            <h4>开发信息</h4>
            <dl className={styles.grid}>
              <div className={styles.field}><dt>业务域</dt><dd><DomainTag name={request.domain} color={domainColor(request.domain, state.domains)} /></dd></div>
              <div className={styles.field}><dt>需求类型</dt><dd><RequestTypeTag value={request.requestType} /></dd></div>
              <div className={styles.field}><dt>开发人</dt><dd>{state.users.find((user) => user.id === request.developer)?.username ?? "-"}</dd></div>
              <div className={styles.field}><dt>开发人天</dt><dd>{formatDays(Number(request.days) || 0)}</dd></div>
              <div className={styles.field}><dt>准入日期</dt><dd>{request.start || "-"}</dd></div>
              <div className={styles.field}><dt>交付日期</dt><dd>{deliveryOf(request) || "-"}</dd></div>
              <div className={`${styles.field} ${styles.wide}`}><dt>望岳工单链接</dt><dd><ReadonlyLink label="望岳工单链接" value={request.wangyue} /></dd></div>
            </dl>
            {plan && plan.segments.length ? (
              <div className={styles.schedule} style={{ marginTop: 16 }}>
                <h4>分段排期</h4>
                <ol>
                  {plan.segments.map((segment, index) => (
                    <li key={index}>
                      {holds.some((gap) => gap.afterIndex === index) ? <span className={styles.hold}>HOLD · {addDays(plan.segments[index - 1]!.end, 1)}—{addDays(segment.start, -1)}</span> : null}
                      <span className={styles.caption}>第 {index + 1} 段</span>
                      <span>{segment.start}—{segment.end}</span>
                      <span>{segmentDays({ start: segment.start, end: segment.end }, calendar)} 人天</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {marks.length ? (
              <div style={{ marginTop: 16 }}>
                <h4>日期标记</h4>
                <div className={styles.marks}>{marks.map((mark) => <span key={`${mark.date}-${mark.label}`}>{mark.date} · {mark.label}</span>)}</div>
              </div>
            ) : null}
          </section>
          <section className={styles.section} aria-label="补充信息">
            <h4>补充信息</h4>
            <dl className={styles.grid}>
              <div className={`${styles.field} ${styles.wide}`}><dt>项目</dt><dd>{request.project || "-"}</dd></div>
              <div className={`${styles.field} ${styles.wide}`}><dt>BRD 链接</dt><dd><ReadonlyLink label="BRD 链接" value={request.brd} /></dd></div>
              <div className={styles.field}><dt>评审日期</dt><dd>{request.review || "-"}</dd></div>
              <div className={styles.field}><dt>预期交付日期</dt><dd>{request.expected || "-"}</dd></div>
              <div className={`${styles.field} ${styles.wide}`}><dt>备注</dt><dd className={styles.notes}>{request.notes || "-"}</dd></div>
            </dl>
          </section>
          {request.archived ? <div className={styles.caption}>归档后不可直接修改，恢复到需求池后可编辑；超级管理员的字段管理统一更新仍会作用于归档需求。</div> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function ReadonlyLink({ label, value }: { label: string; value?: string | null }) {
  const text = (value || "").trim();
  if (!text) return <span style={{ color: "var(--rsm-muted)" }}>-</span>;
  const valid = /^https?:\/\/[^\s]+$/i.test(text);
  return (
    <span style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
      {valid ? <a href={text} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{text}</a> : <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{text}</span>}
      <CopyLinkButton label={label} value={text} />
    </span>
  );
}

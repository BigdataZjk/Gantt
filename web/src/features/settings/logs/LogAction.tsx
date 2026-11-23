import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "../../../api/client";
import type { LogChange, LogDetail, LogEntry, LogValue } from "../../../api/types";
import { isValidHex } from "../../../lib/color";
import { timeLabel } from "../../../lib/dates";
import { roleName } from "../../../lib/format";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../../ui/Tag";
import styles from "./LogAction.module.css";

function ValueTag({ value }: { value: LogValue }) {
  if (value.kind === "priority") return <PriorityTag value={value.text} />;
  if (value.kind === "status") return <StatusTag value={value.text} />;
  if (value.kind === "domain") return <DomainTag name={value.text} color={value.color} />;
  if (value.kind === "requestType") return <RequestTypeTag value={value.text} />;

  let label = value.text;
  if (value.kind === "role") label = roleName(value.text);
  if (value.kind === "timestamp") label = timeLabel(value.text);
  const rank = value.kind === "rank" ? /^第 ([123]) 位$/.exec(value.text)?.[1] : undefined;
  return (
    <span className={styles.value} data-rank={rank}>
      {value.kind === "color" && isValidHex(value.text) ? <span className={styles.swatch} style={{ backgroundColor: value.text }} aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  );
}

function ActionLine({ detail, change, tags, children }: { detail: LogDetail; change?: LogChange; tags?: LogValue[]; children?: ReactNode }) {
  const subject = change?.subject || detail.subject;
  return (
    <div className={styles.line}>
      <span className={styles.action}>{detail.label}</span>
      {subject ? <strong className={styles.subject}>{subject}</strong> : null}
      {change?.field ? <span className={styles.field}>{change.field}</span> : null}
      {change?.tags?.map((value, index) => <ValueTag key={index} value={value} />)}
      {change?.before ? <ValueTag value={change.before} /> : null}
      {change?.before && change.after ? <ArrowRight className={styles.arrow} aria-hidden="true" /> : null}
      {change?.after ? <ValueTag value={change.after} /> : null}
      {tags?.map((value, index) => <ValueTag key={index} value={value} />)}
      {children}
    </div>
  );
}

export function LogAction({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const result = useQuery({
    queryKey: ["history-detail", entry.id, entry.createdAt],
    queryFn: ({ signal }) => api.logDetail(entry.id, signal),
    enabled: expanded,
    retry: false,
    staleTime: Infinity,
  });
  const preview = entry.detail;
  if (!preview) return <span>{entry.action}</span>;

  const full = expanded ? result.data : undefined;
  const previewChanges = preview.changes ?? [];
  const changes = full?.changes ?? previewChanges;
  const toggle = preview.expandable ? (
    <button className={styles.toggle} type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? "收起详情" : preview.remaining ? `展开其余 ${preview.remaining} 项` : "查看详情"}
      {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
  ) : null;
  const showSummary = !previewChanges.length;

  return (
    <div className={styles.content}>
      {showSummary ? <ActionLine detail={preview} tags={preview.tags}>{toggle}</ActionLine> : null}
      {changes.length ? (
        <div className={full ? styles.expandedLines : styles.lines}>
          {changes.map((change, index) => (
            <ActionLine key={index} detail={preview} change={change} tags={!showSummary && index === 0 ? preview.tags : undefined}>
              {!showSummary && !full && index === changes.length - 1 ? toggle : null}
            </ActionLine>
          ))}
        </div>
      ) : null}
      {!showSummary && full ? <div>{toggle}</div> : null}
      {expanded && result.isPending ? <span className={styles.message} role="status">正在读取详情…</span> : null}
      {expanded && result.isError ? (
        <div className={styles.message} role="alert">
          <span>{result.error.message}</span>
          <button className={styles.toggle} type="button" onClick={() => void result.refetch()}>重试</button>
        </div>
      ) : null}
    </div>
  );
}

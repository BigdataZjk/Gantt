import { useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import type { ApiRequest, User } from "../../../api/types";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { PriorityTag } from "../../../ui/Tag";
import styles from "./SupportPicker.module.css";

interface Props {
  date: string;
  developer: string;
  rows: ApiRequest[];
  users: User[];
  onClose: () => void;
  onPick: (id: number) => Promise<boolean>;
}

export function SupportPicker({ date, developer, rows, users, onClose, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const names = new Map(users.map((user) => [user.id, user.username]));
  const query = search.trim().toLowerCase();
  const matches = rows.filter((row) => `${row.name} ${names.get(row.developer) ?? ""}`.toLowerCase().includes(query));
  const validSelection = matches.some((row) => row.id === selected);

  const save = async () => {
    if (selected === null || !validSelection || pending) return;
    setPending(true);
    try {
      if (await onPick(selected)) onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title="安排补位" caption={`${names.get(developer) ?? "开发人"} · ${date}`} width={450} bodyClassName={styles.body} footer={
      <>
        <Button onClick={onClose} disabled={pending}>取消</Button>
        <Button variant="primary" onClick={() => void save()} disabled={pending || !validSelection}>{pending ? "保存中…" : "确认补位"}</Button>
      </>
    }>
      <label className={styles.search}>
        <Search className={styles.searchIcon} aria-hidden="true" />
        <input
          className={styles.searchInput}
          autoFocus
          type="search"
          aria-label="搜索补位需求"
          placeholder="搜索需求名或开发人"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            optionsRef.current?.scrollTo({ top: 0 });
          }}
        />
      </label>
      <div ref={optionsRef} className={styles.options} role="radiogroup" aria-label="补位需求">
        {matches.length ? matches.map((row) => (
          <label key={row.id} className={styles.option}>
            <span className={styles.radio}>
              <input type="radio" name="support-request" value={row.id} checked={row.id === selected} onChange={() => setSelected(row.id)} disabled={pending} />
              {row.id === selected ? <Check aria-hidden="true" /> : null}
            </span>
            <div className={styles.optionText}>
              <span className={styles.optionName}>{row.name}</span>
              <small>{names.get(row.developer) ?? "未分配开发人"}</small>
            </div>
            <PriorityTag value={row.priority} />
          </label>
        )) : <p className={styles.empty}>{rows.length ? "没有匹配的需求" : "需求池中暂无可补位的需求"}</p>}
      </div>
    </Dialog>
  );
}

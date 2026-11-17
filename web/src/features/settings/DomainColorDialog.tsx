import { useMemo, useState } from "react";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { ColorPicker } from "../../ui/ColorPicker";
import { colorFromHex } from "../../lib/color";
import styles from "./Settings.module.css";
import dialogStyles from "./DomainColorDialog.module.css";

interface Props {
  open: boolean;
  title: string;
  caption?: string;
  initialColor: string;
  onOpenChange: (open: boolean) => void;
  onSave: (color: string) => Promise<boolean>;
}

export function DomainColorDialog({ open, title, caption, initialColor, onOpenChange, onSave }: Props) {
  const [color, setColor] = useState(initialColor);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const info = useMemo(() => colorFromHex(color), [color]);
  const days = ["一", "二", "三", "四", "五", "六", "日", "一"];

  const submit = async () => {
    setPending(true);
    const ok = await onSave(color);
    setPending(false);
    if (ok) onOpenChange(false);
    else setError("保存失败，请稍后重试");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setColor(initialColor);
        setError("");
        onOpenChange(next);
      }}
      title={title}
      caption={caption}
      width={360}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" disabled={pending} onClick={() => void submit()}>{pending ? "保存中…" : "保存颜色"}</Button>
        </>
      }
    >
      <div className={dialogStyles.host}>
        <ColorPicker value={color} onChange={setColor} />
        <div className={styles.colorPreview} style={{ ["--task-fill" as string]: color, ["--task-ink" as string]: info.ink } as React.CSSProperties} role="img" aria-label="连续排期条效果预览，周末对应位置淡化">
          <span className={styles.schedulePreviewLabel}>排期效果预览</span>
          <div className={styles.colorDays} aria-hidden="true">{days.map((day, index) => <span key={index} className={index === 5 || index === 6 ? styles.rest : ""}>{day}</span>)}</div>
          <div className={styles.colorBar} aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <span key={index} className={index === 5 || index === 6 ? styles.rest : ""}>{index === 5 || index === 6 ? "" : <i className={styles.point} />}</span>)}</div>
        </div>
        {error ? <p className={dialogStyles.error} role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { Button } from "./Button";

export function CopyLinkButton({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const timer = useRef(0);
  const copied = copiedValue === value;
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const written = await copyText(value, button);
    if (!written || !button.isConnected) return;
    window.clearTimeout(timer.current);
    setCopiedValue(value);
    timer.current = window.setTimeout(() => setCopiedValue(null), 1000);
  };

  const props = {
    type: "button" as const,
    "aria-label": `${copied ? "已复制" : "复制"}${label}`,
    disabled: !value.trim(),
    onClick: copy,
    children: copied ? <Check aria-hidden="true" style={{ color: "var(--rsm-online)" }} /> : <Copy aria-hidden="true" />,
  };

  return compact ? <button {...props} /> : <Button size="sm" variant="quiet" iconOnly {...props} />;
}
